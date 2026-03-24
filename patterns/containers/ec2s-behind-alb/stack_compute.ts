import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { apiKeyParameterName } from '../elastic-container-registry/stack';

export const ec2sAlbComputeStackName = 'Ec2sAlbComputeStack';

interface Ec2sAlbComputeStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  listener: elbv2.ApplicationListener;
}

// ASG of Spot EC2 instances running Docker → ALB listener rule → /ec2s-alb/*
export class Ec2sAlbComputeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Ec2sAlbComputeStackProps) {
    super(scope, id, props);

    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: '/ec2/ec2s-behind-alb',
      // !! Change the following in production.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: logs.RetentionDays.ONE_WEEK,
    });

    const instanceSg = new ec2.SecurityGroup(this, 'InstanceSG', {
      vpc: props.vpc,
      description: 'Security group for EC2 instances - inbound only from ALB',
    });

    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        // ECR pull: GetAuthorizationToken, BatchGetImage, BatchCheckLayerAvailability
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
        // SSM Session Manager: ssmmessages, ec2messages (for debugging via `aws ssm start-session`)
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // ssm:GetParameter for the API key (scoped to the specific parameter)
    const apiKey = ssm.StringParameter.fromSecureStringParameterAttributes(this, 'ApiKey', {
      parameterName: apiKeyParameterName,
    });
    apiKey.grantRead(role);

    // CloudWatch Logs: the Docker awslogs driver needs CreateLogStream + PutLogEvents
    logGroup.grantWrite(role);

    // fromRepositoryName avoids a cross-stack reference — the ECR stack need not be deployed first
    const repository = ecr.Repository.fromRepositoryName(this, 'Repo', 'hands-on-containers');

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euo pipefail',
      // Install Docker on Amazon Linux 2023
      'dnf install -y docker',
      'systemctl enable --now docker',
      // Authenticate to ECR
      `aws ecr get-login-password --region ${this.region} | docker login --username AWS --password-stdin ${this.account}.dkr.ecr.${this.region}.amazonaws.com`,
      // Pull the container image
      `docker pull ${repository.repositoryUri}:latest`,
      // Read API key from SSM SecureString
      `API_KEY=$(aws ssm get-parameter --name ${apiKeyParameterName} --with-decryption --query Parameter.Value --output text --region ${this.region})`,
      // Run the container with:
      //   --restart=always: Docker restarts the container on crash (no systemd unit needed)
      //   --log-driver=awslogs: sends stdout/stderr to CloudWatch (requires log group + IAM permissions)
      //   ROUTE_PREFIX=/ec2s-alb: Express mounts router under this prefix for ALB path-based routing
      [
        'docker run -d --name api --restart=always -p 3000:3000',
        `--log-driver=awslogs --log-opt awslogs-region=${this.region} --log-opt awslogs-group=${logGroup.logGroupName}`,
        `-e API_KEY="$API_KEY" -e ROUTE_PREFIX=/ec2s-alb`,
        `${repository.repositoryUri}:latest`,
      ].join(' '),
    );

    const launchTemplate = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.ARM_64 }),
      userData,
      role,
      securityGroup: instanceSg,
      // IMDSv2 required — prevents SSRF-based metadata credential theft
      httpTokens: ec2.LaunchTemplateHttpTokens.REQUIRED,
    });

    const asg = new autoscaling.AutoScalingGroup(this, 'ASG', {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      // mixedInstancesPolicy is the only way to use Spot with fleet-level controls (allocation strategy,
      // On-Demand/Spot ratio, multi-type diversity). Without it, a bare launchTemplate gives 100% On-Demand
      // with a single instance type; the legacy spotPrice field on the launch template is deprecated.
      mixedInstancesPolicy: {
        launchTemplate,
        instancesDistribution: {
          // 100% Spot — no on-demand fallback. Tradeoff: ~60% cost saving, higher interruption risk.
          onDemandBaseCapacity: 0, // 0 on-demand instance as the floor
          onDemandPercentageAboveBaseCapacity: 0, // 0% on-demand instances above the floor → 100% Spot instance
          // PRICE_CAPACITY_OPTIMIZED picks pools with lowest interruption risk AND lowest price
          // This is AWS-recommended default.
          spotAllocationStrategy: autoscaling.SpotAllocationStrategy.PRICE_CAPACITY_OPTIMIZED,
        },
        // Multiple ARM64 types give PRICE_CAPACITY_OPTIMIZED more Spot pools to evaluate per AZ.
        // With a single type, the algorithm has only one pool per AZ — no diversity to optimize over.
        // All types must be ARM64 to match the launch template's AMI (Amazon Linux 2023 ARM_64).
        launchTemplateOverrides: [
          { instanceType: new ec2.InstanceType('t4g.micro') },
          { instanceType: new ec2.InstanceType('t4g.small') },
          { instanceType: new ec2.InstanceType('c7g.medium') },
        ],
      },
      // !! in production set minCapacity to minimze Spot instance disruption risk
      minCapacity: 1,
      maxCapacity: 4,
      // Proactively replaces Spot instances that receive a rebalance recommendation
      // before the 2-minute interruption notice — reduces downtime from Spot reclaims
      capacityRebalance: true,
      // ELB health check: ASG marks instances unhealthy if the ALB target group reports them as unhealthy.
      // Grace period gives instances time to boot, install Docker, pull image, and start the container.
      // 120s is ~2min; adjust up if image pull is slow (large image or low network throughput).
      healthChecks: autoscaling.HealthChecks.withAdditionalChecks({
        additionalTypes: [autoscaling.AdditionalHealthCheckType.ELB],
        gracePeriod: cdk.Duration.seconds(120),
      }),
      // Rolling update: replaces instances in batches, keeping min healthy capacity during deploys.
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate(),
    });

    // INSTANCE target type — ASG registers EC2 instance IDs; ALB routes to instance:port
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc: props.vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.INSTANCE,
      // 30s drain: default is 300s, which is too slow for Spot replacements. 30s matches typical
      // request latency and gives in-flight requests time to complete before the instance is removed.
      deregistrationDelay: cdk.Duration.seconds(30),
      healthCheck: {
        path: '/ec2s-alb/health',
        interval: cdk.Duration.seconds(30),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    asg.attachToApplicationTargetGroup(targetGroup);

    // Path-based routing: /ec2s-alb and /ec2s-alb/* → this service's target group
    // Priority 200 — ecs-fargate-alb uses 100; each service picks a unique priority
    new elbv2.ApplicationListenerRule(this, 'Ec2sAlbRule', {
      listener: props.listener,
      priority: 200,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/ec2s-alb', '/ec2s-alb/*'])],
      targetGroups: [targetGroup],
    });

    asg.scaleOnCpuUtilization('ScaleOnCpu', {
      targetUtilizationPercent: 50,
      cooldown: cdk.Duration.minutes(5),
      // Instance needs ~2min to boot + pull image + start Docker; ignore metrics from warming instances
      estimatedInstanceWarmup: cdk.Duration.seconds(120),
    });
  }
}

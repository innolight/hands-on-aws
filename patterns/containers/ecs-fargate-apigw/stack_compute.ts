import * as cdk from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import {apiKeyParameterName} from '../elastic-container-registry/stack';

export const ecsFargateComputeStackName = 'EcsFargateComputeStack';

interface EcsFargateComputeStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  cluster: ecs.Cluster;
  namespace: servicediscovery.PrivateDnsNamespace;
}

// ECR image → ECS Fargate task (private subnet) → Cloud Map
export class EcsFargateComputeStack extends cdk.Stack {
  public readonly cloudMapService: servicediscovery.IService;
  public readonly taskSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: EcsFargateComputeStackProps) {
    super(scope, id, props);

    // Task SG: ingress rule added by the networking stack via CfnSecurityGroupIngress
    this.taskSg = new ec2.SecurityGroup(this, 'TaskSG', {
      vpc: props.vpc,
      description: 'Security group for ECS Fargate tasks',
    });

    // --- SSM SecureString reference (created manually, see elastic-container-registry README) ---
    const apiKey = ssm.StringParameter.fromSecureStringParameterAttributes(this, 'ApiKey', {
      parameterName: apiKeyParameterName,
    });

    // --- ECS Task Definition ---
    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      // Minimum Fargate size — sufficient for this Express API (~$9/mo)
      cpu: 256,
      memoryLimitMiB: 512,
      // ARM64 (Graviton) is ~20% cheaper than x86 and matches Apple Silicon local builds
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
      },
    });

    const taskLogGroup = new logs.LogGroup(this, 'TaskLogGroup', {
      logGroupName: '/ecs/ecs-fargate-apigw',
      // !! Change the following in production.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: logs.RetentionDays.ONE_WEEK,
    });

    // fromRepositoryName avoids a cross-stack reference — the ECR stack need not be deployed first
    const repository = ecr.Repository.fromRepositoryName(this, 'Repo', 'hands-on-containers');

    taskDef.addContainer('app', {
      image: ecs.ContainerImage.fromEcrRepository(repository, 'latest'),
      portMappings: [{containerPort: 3000}],
      // if you don't add a logging driver to the container definition, there are no logs at all
      logging: ecs.LogDrivers.awsLogs({logGroup: taskLogGroup, streamPrefix: 'ecs'}),
      // CDK auto-grants ssm:GetParameters on the execution role (not the task role)
      secrets: {
        API_KEY: ecs.Secret.fromSsmParameter(apiKey),
      },
      healthCheck: {
        // Alpine-based image has wget but NOT curl
        command: ['CMD-SHELL', 'wget -qO- http://localhost:3000/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(10),
      },
    });

    // --- ECS Fargate Service ---
    const fargateService = new ecs.FargateService(this, 'Service', {
      cluster: props.cluster,
      taskDefinition: taskDef,
      // !! Change the following in production: use desiredCount >= 2 across AZs
      desiredCount: 1,
      securityGroups: [this.taskSg],
      vpcSubnets: {subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS},
      // Rolling update: replaces tasks in-place without a load balancer.
      // Alternatives: CODE_DEPLOY (blue/green, requires ALB) or EXTERNAL (third-party controller).
      deploymentController: {type: ecs.DeploymentControllerType.ECS},
      // minHealthyPercent=100 keeps the old task running until the new one is healthy;
      // maxHealthyPercent=200 allows a second task temporarily — zero downtime with desiredCount=1.
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      // Circuit breaker: stops retrying and rolls back to the last working task definition after
      // ~10 consecutive failures, instead of looping forever (default ECS behavior).
      circuitBreaker: {enable: true, rollback: true},
      // Register tasks with Cloud Map so API Gateway can discover them via VPC Link
      cloudMapOptions: {
        cloudMapNamespace: props.namespace,
        containerPort: 3000,
        dnsRecordType: servicediscovery.DnsRecordType.SRV,
      },
    });

    // minCapacity: 1 — target tracking cannot scale to 0; it needs at least one task to evaluate CPU.
    // True scale-to-zero requires a step scaling policy on request count (e.g. 0 req → remove all tasks).
    const scalableTarget = fargateService.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 3,
    });

    scalableTarget.scaleOnCpuUtilization('ScaleOnCpu', {
      targetUtilizationPercent: 50,
      scaleInCooldown: cdk.Duration.minutes(5),
      scaleOutCooldown: cdk.Duration.seconds(30),
    });

    this.cloudMapService = fargateService.cloudMapService!;
  }
}

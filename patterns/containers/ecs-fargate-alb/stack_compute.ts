import * as cdk from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import {apiKeyParameterName} from '../elastic-container-registry/stack';

export const ecsFargateAlbComputeStackName = 'EcsFargateAlbComputeStack';

interface EcsFargateAlbComputeStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  cluster: ecs.Cluster;
  listener: elbv2.ApplicationListener;
}

// ECS Fargate task (private subnet) → ALB listener rule → /quote-service/*
export class EcsFargateAlbComputeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EcsFargateAlbComputeStackProps) {
    super(scope, id, props);

    const taskSg = new ec2.SecurityGroup(this, 'TaskSG', {
      vpc: props.vpc,
      description: 'Security group for ECS Fargate tasks',
    });

    // --- SSM SecureString reference (created manually, see elastic-container-registry README) ---
    const apiKey = ssm.StringParameter.fromSecureStringParameterAttributes(this, 'ApiKey', {
      parameterName: apiKeyParameterName,
    });

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
      logGroupName: '/ecs/ecs-fargate-alb',
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
      environment: {
        // ALB does not rewrite paths — the container receives /quote-service/health as-is.
        // Express mounts the router under this prefix so routes match correctly.
        ROUTE_PREFIX: '/quote-service',
      },
      healthCheck: {
        // Alpine-based image has wget but NOT curl
        command: ['CMD-SHELL', 'wget -qO- http://localhost:3000/quote-service/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(10),
      },
    });

    const fargateService = new ecs.FargateService(this, 'Service', {
      cluster: props.cluster,
      taskDefinition: taskDef,
      // !! Change the following in production: use desiredCount >= 2 across AZs
      desiredCount: 1,
      securityGroups: [taskSg],
      vpcSubnets: {subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS},
      deploymentController: {type: ecs.DeploymentControllerType.ECS},
      // When true, enables `aws ecs execute-command` to shell into running tasks (via SSM).
      // Requires SSM agent in the image and ssm:StartSession + ssmmessages:* on the task role.
      // Keep false in production unless actively debugging — reduces attack surface.
      enableExecuteCommand: false,
      // minHealthyPercent=100 keeps the old task running until the new one is healthy;
      // maxHealthyPercent=200 allows a second task temporarily — zero downtime with desiredCount=1.
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      // Circuit breaker: stops retrying and rolls back to the last working task definition after
      // ~10 consecutive failures, instead of looping forever (default ECS behavior).
      circuitBreaker: {enable: true, rollback: true},
    });

    // IP target type required for Fargate — tasks register directly by IP, not EC2 instance ID
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc: props.vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      // ALB default is 300s — excessive for short-lived API responses. Lower to 30s for faster
      // scale-in: tasks finish in-flight requests quickly and deregister without a long wait.
      deregistrationDelay: cdk.Duration.seconds(30),
      healthCheck: {
        // ALB sends health checks directly to task IP:port, bypassing listener rules —
        // the path must include the prefix the app expects.
        path: '/quote-service/health',
        interval: cdk.Duration.seconds(30),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    // Register tasks with the target group.
    fargateService.attachToApplicationTargetGroup(targetGroup);

    // Path-based routing: /quote-service and /quote-service/* → this service's target group.
    // Each service owns its listener rule with a unique priority (100 for quote-service;
    // new services pick a different priority, e.g. 200, 300).
    // CDK Connections tracking auto-adds a SecurityGroupIngress rule (ALB SG → task SG, port 3000)
    // because the listener rule links the target group to the ALB's listener.
    new elbv2.ApplicationListenerRule(this, 'QuoteServiceRule', {
      listener: props.listener,
      priority: 100,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/quote-service', '/quote-service/*'])],
      targetGroups: [targetGroup],
    });

    // minCapacity: 1 — target tracking cannot scale to 0; it needs at least one task to evaluate CPU.
    const scalableTarget = fargateService.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 3,
    });

    scalableTarget.scaleOnCpuUtilization('ScaleOnCpu', {
      targetUtilizationPercent: 50,
      scaleInCooldown: cdk.Duration.minutes(5),
      scaleOutCooldown: cdk.Duration.seconds(30),
    });
  }
}

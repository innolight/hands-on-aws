import * as cdk from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import {apiKeyParameterName} from '../elastic-container-registry/stack';

export const ecsEc2AlbComputeStackName = 'EcsEc2AlbComputeStack';

interface EcsEc2AlbComputeStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  cluster: ecs.Cluster;
  listener: elbv2.ApplicationListener;
  instanceSg: ec2.SecurityGroup;
  albSg: ec2.SecurityGroup;
  capacityProviderName: string;
}

// ECS EC2 task (bridge mode, dynamic port) → ALB listener rule → /ecs-ec2-alb/*
export class EcsEc2AlbComputeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EcsEc2AlbComputeStackProps) {
    super(scope, id, props);

    // --- SSM SecureString reference (created manually, see elastic-container-registry README) ---
    const apiKey = ssm.StringParameter.fromSecureStringParameterAttributes(this, 'ApiKey', {
      parameterName: apiKeyParameterName,
    });

    const taskLogGroup = new logs.LogGroup(this, 'TaskLogGroup', {
      logGroupName: '/ecs/ecs-ec2-alb',
      // !! Change the following in production.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: logs.RetentionDays.ONE_WEEK,
    });

    // --- EC2 Task Definition ---
    // EC2 compatibility (not Fargate): tasks run on the cluster's registered EC2 instances.
    // BRIDGE network mode uses Docker's built-in bridge network — the default for ECS on EC2.
    // Alternative: AWSVPC gives each task its own ENI (same isolation as Fargate), but
    // ENI density limits tasks per instance (t4g.micro = 2 ENIs = 2 tasks max).
    // Bridge mode has no ENI limit — multiple tasks share the host's network via port mapping.
    const taskDef = new ecs.Ec2TaskDefinition(this, 'TaskDef', {
      networkMode: ecs.NetworkMode.BRIDGE,
    });

    // fromRepositoryName avoids a cross-stack reference — the ECR stack need not be deployed first
    const repository = ecr.Repository.fromRepositoryName(this, 'Repo', 'hands-on-containers');

    taskDef.addContainer('app', {
      image: ecs.ContainerImage.fromEcrRepository(
        repository,
        this.node.tryGetContext('imageDigest') ?? 'latest',
      ),
      // EC2 task defs set CPU/memory per container (not at task level like Fargate).
      // 256 CPU units = 0.25 vCPU, 512 MiB — matches the Fargate patterns' sizing.
      cpu: 256,
      memoryLimitMiB: 512,
      portMappings: [{
        containerPort: 3000,
        // hostPort 0 = dynamic port mapping: Docker picks a random ephemeral port (32768-65535).
        // The ECS agent registers this port with the ALB target group, so the ALB knows where to route.
        // This allows multiple tasks on the same EC2 instance — each gets a different host port.
        // Alternative: fixed hostPort 3000 — limits to 1 task per instance.
        hostPort: 0,
        protocol: ecs.Protocol.TCP,
      }],
      logging: ecs.LogDrivers.awsLogs({logGroup: taskLogGroup, streamPrefix: 'ecs'}),
      // ECS injects secrets at task start via the execution role (ssm:GetParameters).
      // Alternative: read SSM in EC2 user data (like ec2s-behind-alb) — bakes the key at boot time,
      // stale if rotated, and visible via `docker inspect`. ECS secrets refresh on each task launch.
      secrets: {
        API_KEY: ecs.Secret.fromSsmParameter(apiKey),
      },
      environment: {
        // ALB does not rewrite paths — the container receives /ecs-ec2-alb/health as-is.
        // Express mounts the router under this prefix so routes match correctly.
        ROUTE_PREFIX: '/ecs-ec2-alb',
      },
      healthCheck: {
        // Alpine-based image has wget but NOT curl
        command: ['CMD-SHELL', 'wget -qO- http://localhost:3000/ecs-ec2-alb/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(10),
      },
    });

    // --- ECS Service ---
    const service = new ecs.Ec2Service(this, 'Service', {
      cluster: props.cluster,
      taskDefinition: taskDef,
      // !! Change in production: use desiredCount >= 2 across AZs
      desiredCount: 1,
      // Route tasks to the ASG capacity provider — ECS scales the ASG to match task demand.
      // Without this, ECS would try the default capacity provider strategy (if any) or fail.
      capacityProviderStrategies: [{
        capacityProvider: props.capacityProviderName,
        weight: 1,
      }],
      // When true, enables `aws ecs execute-command` to open a shell in a running container via SSM.
      // Useful for debugging: aws ecs execute-command --cluster X --task Y --interactive --command /bin/sh
      // Requires ssmmessages:* on the task role. Keep false in production — reduces attack surface.
      enableExecuteCommand: false,
      
      // Rolling update strategy — tuned via these two knobs:
      //   minHealthyPercent=100: old task stays alive until new one passes ALB health checks → no downtime gap.
      //   maxHealthyPercent=200: allows a 2nd task to run temporarily during the cutover.
      // Alternative — recreate (faster deploy, brief downtime): minHealthyPercent=0, maxHealthyPercent=100.
      //   ECS stops the old task first, then starts the new one. No extra capacity needed.
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      // Circuit breaker: stops retrying and rolls back to the last working task definition after
      // ~10 consecutive failures, instead of looping forever (default ECS behavior without this).
      circuitBreaker: {enable: true, rollback: true},
    });

    // --- Target Group ---
    // INSTANCE target type: ASG registers EC2 instance IDs; ALB routes to instance:ephemeral-port.
    // Fargate uses IP target type instead (tasks register by IP since there's no EC2 instance).
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc: props.vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.INSTANCE,
      // ALB default is 300s — excessive for short-lived API responses. 30s gives in-flight
      // requests time to complete during Spot replacements without unnecessary drain delay.
      deregistrationDelay: cdk.Duration.seconds(30),
      healthCheck: {
        // ALB sends health checks directly to instance:port, not through the listener rule —
        // the path must include the prefix the app expects.
        path: '/ecs-ec2-alb/health',
        interval: cdk.Duration.seconds(30),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    // Register tasks with the target group. ECS registers the instance ID + dynamic host port.
    service.attachToApplicationTargetGroup(targetGroup);

    // Bridge-mode tasks run on the host network: traffic hits the EC2 instance on the ephemeral
    // port range (32768-65535), not the container directly. CDK auto-wires this rule for awsvpc
    // mode (Fargate), but for bridge mode with a cross-stack capacity provider it does not.
    // L1 ingress rule avoids cross-stack SG mutation (matches the ecs-fargate-apigw pattern).
    new ec2.CfnSecurityGroupIngress(this, 'InstanceSgIngress', {
      groupId: props.instanceSg.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 32768,
      toPort: 65535,
      sourceSecurityGroupId: props.albSg.securityGroupId,
      description: 'ALB to ECS tasks - bridge-mode dynamic ports (32768-65535)',
    });

    // --- Listener Rule ---
    // Path-based routing: /ecs-ec2-alb and /ecs-ec2-alb/* → this service's target group.
    // Priority 100 — this ALB is dedicated to this pattern (not shared with ecs-fargate-alb).
    new elbv2.ApplicationListenerRule(this, 'ListenerRule', {
      listener: props.listener,
      priority: 100,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/ecs-ec2-alb', '/ecs-ec2-alb/*'])],
      targetGroups: [targetGroup],
    });

    // --- Service Auto-Scaling (task level) ---
    // Two auto-scaling layers work together:
    //   1. Service auto-scaling (this): adjusts desired task count based on CPU
    //   2. Capacity provider managed scaling (cluster stack): adjusts ASG desired count
    //      to ensure enough EC2 instances for the tasks ECS wants to place
    // minCapacity: 1 — target tracking cannot scale to 0; needs at least one task to measure CPU.
    const scalableTarget = service.autoScaleTaskCount({minCapacity: 1, maxCapacity: 3});
    scalableTarget.scaleOnCpuUtilization('ScaleOnCpu', {
      targetUtilizationPercent: 50,
      scaleInCooldown: cdk.Duration.minutes(5),
      scaleOutCooldown: cdk.Duration.seconds(30),
    });
  }
}

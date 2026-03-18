import * as cdk from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import {HttpServiceDiscoveryIntegration} from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import {apiKeyParameterName} from '../elastic-container-registry/stack';

export const ecsFargateApigwStackName = 'EcsFargateApigwStack';

interface EcsFargateApigwStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  repository: ecr.Repository;
  cluster: ecs.Cluster;
  namespace: servicediscovery.PrivateDnsNamespace;
  vpcLink: apigwv2.VpcLink;
  vpcLinkSg: ec2.SecurityGroup;
}

// ECR image → ECS Fargate task (private subnet) → Cloud Map → VPC Link → API Gateway HTTP API
export class EcsFargateApigwStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EcsFargateApigwStackProps) {
    super(scope, id, props);

    // Task SG: only accept traffic from the VPC Link — explicit SG chaining enforces
    // that the only path to the container is API GW → VPC Link → task
    const taskSg = new ec2.SecurityGroup(this, 'TaskSG', {
      vpc: props.vpc,
      description: 'Security group for ECS Fargate tasks',
    });
    taskSg.addIngressRule(props.vpcLinkSg, ec2.Port.tcp(3000), 'Allow traffic from VPC Link only');

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

    taskDef.addContainer('app', {
      image: ecs.ContainerImage.fromEcrRepository(props.repository, 'latest'),
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
      securityGroups: [taskSg],
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

    // --- API Gateway HTTP API ---
    const accessLogGroup = new logs.LogGroup(this, 'ApiAccessLogGroup', {
      logGroupName: '/apigateway/ecs-fargate-apigw',
      // !! Change the following in production.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: logs.RetentionDays.ONE_WEEK,
    });

    

    const httpApi = new apigwv2.HttpApi(this, 'HttpApi');

    // Explicit routes instead of defaultIntegration ($default catch-all) — only /health and /quote
    // are forwarded to the ECS service; any other path returns 404 from API Gateway itself.
    const integration = new HttpServiceDiscoveryIntegration('CloudMapIntegration',
      fargateService.cloudMapService!,
      {vpcLink: props.vpcLink},
    );
    httpApi.addRoutes({path: '/health', methods: [apigwv2.HttpMethod.GET], integration});
    // /quote and all sub-paths (e.g. /quote/random, /quote/category/tech), all HTTP methods
    httpApi.addRoutes({path: '/quote', methods: [apigwv2.HttpMethod.ANY], integration});
    httpApi.addRoutes({path: '/quote/{proxy+}', methods: [apigwv2.HttpMethod.ANY], integration});

    // Access logs help debug VPC Link connectivity issues — worth the small cost
    // Without accessLogSettings on the stage, API Gateway produces no access logs.
    const stage = httpApi.defaultStage!.node.defaultChild as apigwv2.CfnStage;
    stage.accessLogSettings = {
      destinationArn: accessLogGroup.logGroupArn,
      format: '$context.requestId $context.httpMethod $context.path $context.status $context.integrationLatency',
    };

    new cdk.CfnOutput(this, 'ApiEndpoint', {value: httpApi.apiEndpoint});
  }
}

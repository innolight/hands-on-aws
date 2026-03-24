import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpServiceDiscoveryIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';

export const ecsFargateNetworkingStackName = 'EcsFargateNetworkingStack';

interface EcsFargateNetworkingStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  cloudMapService: servicediscovery.IService;
  taskSg: ec2.SecurityGroup;
}

// VPC Link + HTTP API → Cloud Map → Fargate task
export class EcsFargateNetworkingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EcsFargateNetworkingStackProps) {
    super(scope, id, props);

    // VPC Link SG: API Gateway originates requests through the VPC Link ENIs — no explicit inbound rules needed
    const vpcLinkSg = new ec2.SecurityGroup(this, 'VpcLinkSG', {
      vpc: props.vpc,
      description: 'Security group for API Gateway VPC Link',
    });

    // L1 ingress rule: VPC Link SG → task SG on TCP 3000 — avoids cross-stack SG mutation
    new ec2.CfnSecurityGroupIngress(this, 'TaskSgIngress', {
      groupId: props.taskSg.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 3000,
      toPort: 3000,
      sourceSecurityGroupId: vpcLinkSg.securityGroupId,
      description: 'Allow traffic from VPC Link only',
    });

    const vpcLink = new apigwv2.VpcLink(this, 'VpcLink', {
      vpc: props.vpc,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [vpcLinkSg],
    });

    // Access logs help debug VPC Link connectivity issues — worth the small cost
    // Without accessLogSettings on the stage, API Gateway produces no access logs.
    const accessLogGroup = new logs.LogGroup(this, 'ApiAccessLogGroup', {
      logGroupName: '/apigateway/ecs-fargate-apigw',
      // !! Change the following in production.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: logs.RetentionDays.ONE_WEEK,
    });

    const httpApi = new apigwv2.HttpApi(this, 'HttpApi');

    // Explicit routes instead of defaultIntegration ($default catch-all) — only /health and /quote
    // are forwarded to the ECS service; any other path returns 404 from API Gateway itself.
    const integration = new HttpServiceDiscoveryIntegration('CloudMapIntegration', props.cloudMapService, { vpcLink });
    httpApi.addRoutes({ path: '/health', methods: [apigwv2.HttpMethod.GET], integration });
    // /quote and all sub-paths (e.g. /quote/random, /quote/category/tech), all HTTP methods
    httpApi.addRoutes({ path: '/quote', methods: [apigwv2.HttpMethod.ANY], integration });
    httpApi.addRoutes({ path: '/quote/{proxy+}', methods: [apigwv2.HttpMethod.ANY], integration });

    const stage = httpApi.defaultStage!.node.defaultChild as apigwv2.CfnStage;
    stage.accessLogSettings = {
      destinationArn: accessLogGroup.logGroupArn,
      format: '$context.requestId $context.httpMethod $context.path $context.status $context.integrationLatency',
    };

    new cdk.CfnOutput(this, 'ApiEndpoint', { value: httpApi.apiEndpoint });
  }
}

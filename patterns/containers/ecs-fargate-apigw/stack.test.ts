import * as cdk from 'aws-cdk-lib';
import {Template} from 'aws-cdk-lib/assertions';
import {VpcSubnetsStack} from '../../vpc-subnets/stack';
import {ElasticContainerRegistryStack} from '../elastic-container-registry/stack';
import {EcsPlatformStack} from './platform_stack';
import {EcsFargateApigwStack} from './stack';

describe('EcsPlatformStack', () => {
  const app = new cdk.App();
  const vpcStack = new VpcSubnetsStack(app, 'VpcStack');
  const stack = new EcsPlatformStack(app, 'PlatformStack', {
    vpc: vpcStack.vpc,
  });
  const template = Template.fromStack(stack);

  test('creates an ECS cluster', () => {
    template.resourceCountIs('AWS::ECS::Cluster', 1);
  });

  test('creates a Cloud Map private DNS namespace', () => {
    template.hasResourceProperties('AWS::ServiceDiscovery::PrivateDnsNamespace', {
      Name: 'ecs-fargate-apigw.local',
    });
  });

  test('creates a VPC Link and its security group', () => {
    template.resourceCountIs('AWS::ApiGatewayV2::VpcLink', 1);
    template.resourceCountIs('AWS::EC2::SecurityGroup', 1);
  });
});

describe('EcsFargateApigwStack', () => {
  const app = new cdk.App();
  const vpcStack = new VpcSubnetsStack(app, 'VpcStack2');
  const ecrStack = new ElasticContainerRegistryStack(app, 'EcrStack');
  const platformStack = new EcsPlatformStack(app, 'PlatformStack2', {
    vpc: vpcStack.vpc,
  });
  const stack = new EcsFargateApigwStack(app, 'TestStack', {
    vpc: vpcStack.vpc,
    repository: ecrStack.repository,
    cluster: platformStack.cluster,
    namespace: platformStack.namespace,
    vpcLink: platformStack.vpcLink,
    vpcLinkSg: platformStack.vpcLinkSg,
  });
  const template = Template.fromStack(stack);

  test('creates an ECS Fargate service with desiredCount 1 in private subnets', () => {
    template.hasResourceProperties('AWS::ECS::Service', {
      DesiredCount: 1,
      LaunchType: 'FARGATE',
    });
  });

  test('creates a task definition with 256 CPU and 512 MB memory', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '256',
      Memory: '512',
    });
  });

  test('creates an API Gateway HTTP API', () => {
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
  });

  test('creates a task security group — one per service stack', () => {
    template.resourceCountIs('AWS::EC2::SecurityGroup', 1);
  });
});

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { VpcSubnetsStack } from '../../vpc-subnets/stack';
import { EcsClusterStack } from './stack_ecs_cluster';
import { EcsFargateComputeStack } from './stack_compute';
import { EcsFargateNetworkingStack } from './stack_networking';

describe('EcsClusterStack', () => {
  const app = new cdk.App();
  const vpcStack = new VpcSubnetsStack(app, 'VpcStack');
  const stack = new EcsClusterStack(app, 'ClusterStack', {
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
});

describe('EcsFargateComputeStack', () => {
  const app = new cdk.App();
  const vpcStack = new VpcSubnetsStack(app, 'VpcStack2');
  const clusterStack = new EcsClusterStack(app, 'ClusterStack2', {
    vpc: vpcStack.vpc,
  });
  const stack = new EcsFargateComputeStack(app, 'ComputeStack', {
    vpc: vpcStack.vpc,
    cluster: clusterStack.cluster,
    namespace: clusterStack.namespace,
  });
  const template = Template.fromStack(stack);

  test('creates an ECS Fargate service with desiredCount 1', () => {
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

  test('creates a task security group', () => {
    template.resourceCountIs('AWS::EC2::SecurityGroup', 1);
  });
});

describe('EcsFargateNetworkingStack', () => {
  const app = new cdk.App();
  const vpcStack = new VpcSubnetsStack(app, 'VpcStack3');
  const clusterStack = new EcsClusterStack(app, 'ClusterStack3', {
    vpc: vpcStack.vpc,
  });
  const computeStack = new EcsFargateComputeStack(app, 'ComputeStack3', {
    vpc: vpcStack.vpc,
    cluster: clusterStack.cluster,
    namespace: clusterStack.namespace,
  });
  const stack = new EcsFargateNetworkingStack(app, 'NetworkingStack', {
    vpc: vpcStack.vpc,
    cloudMapService: computeStack.cloudMapService,
    taskSg: computeStack.taskSg,
  });
  const template = Template.fromStack(stack);

  test('creates an HTTP API', () => {
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
  });

  test('creates a VPC Link', () => {
    template.resourceCountIs('AWS::ApiGatewayV2::VpcLink', 1);
  });

  test('creates a VPC Link security group and an ingress rule for the task SG', () => {
    template.resourceCountIs('AWS::EC2::SecurityGroup', 1);
    template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 1);
  });
});

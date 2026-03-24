import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { VpcSubnetsStack } from '../../vpc-subnets/stack';
import { EcsEc2AlbNetworkingStack } from './stack_networking';
import { EcsEc2ClusterStack } from './stack_cluster';
import { EcsEc2AlbComputeStack } from './stack_compute';

describe('EcsEc2AlbNetworkingStack', () => {
  const app = new cdk.App();
  const vpcStack = new VpcSubnetsStack(app, 'VpcStack');
  const stack = new EcsEc2AlbNetworkingStack(app, 'NetworkingStack', {
    vpc: vpcStack.vpc,
  });
  const template = Template.fromStack(stack);

  test('creates an internet-facing ALB', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internet-facing',
      Type: 'application',
    });
  });

  test('creates listener on port 80', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      Protocol: 'HTTP',
    });
  });

  test('creates an ALB security group', () => {
    template.resourceCountIs('AWS::EC2::SecurityGroup', 1);
  });
});

describe('EcsEc2ClusterStack', () => {
  const app = new cdk.App();
  const vpcStack = new VpcSubnetsStack(app, 'VpcStack2');
  const stack = new EcsEc2ClusterStack(app, 'ClusterStack', {
    vpc: vpcStack.vpc,
  });
  const template = Template.fromStack(stack);

  test('creates an ECS cluster', () => {
    template.resourceCountIs('AWS::ECS::Cluster', 1);
  });

  test('creates an ASG with min 1 and max 4', () => {
    template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      MinSize: '1',
      MaxSize: '4',
    });
  });

  test('creates a launch template with IMDSv2 required', () => {
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: Match.objectLike({
        MetadataOptions: Match.objectLike({
          HttpTokens: 'required',
        }),
      }),
    });
  });

  test('registers capacity provider with cluster', () => {
    template.resourceCountIs('AWS::ECS::ClusterCapacityProviderAssociations', 1);
  });
});

describe('EcsEc2AlbComputeStack', () => {
  const app = new cdk.App();
  const vpcStack = new VpcSubnetsStack(app, 'VpcStack3');
  const clusterStack = new EcsEc2ClusterStack(app, 'ClusterStack2', {
    vpc: vpcStack.vpc,
  });
  const networkingStack = new EcsEc2AlbNetworkingStack(app, 'NetworkingStack2', {
    vpc: vpcStack.vpc,
  });
  const stack = new EcsEc2AlbComputeStack(app, 'ComputeStack', {
    vpc: vpcStack.vpc,
    cluster: clusterStack.cluster,
    listener: networkingStack.listener,
    instanceSg: clusterStack.instanceSg,
    albSg: networkingStack.albSg,
    capacityProviderName: clusterStack.capacityProviderName,
  });
  const template = Template.fromStack(stack);

  test('creates a task definition with bridge network mode', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      NetworkMode: 'bridge',
    });
  });

  test('creates an ECS service with desiredCount 1', () => {
    template.hasResourceProperties('AWS::ECS::Service', {
      DesiredCount: 1,
    });
  });

  test('creates a target group with instance target type', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      TargetType: 'instance',
    });
  });

  test('creates a listener rule for /ecs-ec2-alb paths with priority 100', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Priority: 100,
      Conditions: Match.arrayWith([
        Match.objectLike({
          Field: 'path-pattern',
          PathPatternConfig: { Values: ['/ecs-ec2-alb', '/ecs-ec2-alb/*'] },
        }),
      ]),
    });
  });

  test('creates a log group with 7-day retention', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      RetentionInDays: 7,
    });
  });
});

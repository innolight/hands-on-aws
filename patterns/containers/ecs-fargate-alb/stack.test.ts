import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { VpcSubnetsStack } from '../../vpc-subnets/stack';
import { EcsClusterStack } from '../ecs-fargate-apigw/stack_ecs_cluster';
import { EcsFargateAlbNetworkingStack } from './stack_networking';
import { EcsFargateAlbComputeStack } from './stack_compute';

describe('EcsFargateAlbNetworkingStack', () => {
  const app = new cdk.App();
  const vpcStack = new VpcSubnetsStack(app, 'VpcStack');
  const stack = new EcsFargateAlbNetworkingStack(app, 'NetworkingStack', {
    vpc: vpcStack.vpc,
  });
  const template = Template.fromStack(stack);

  test('creates an internet-facing ALB', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internet-facing',
      Type: 'application',
    });
  });

  test('listener default action returns 404 fixed response', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      Protocol: 'HTTP',
      DefaultActions: Match.arrayWith([
        Match.objectLike({
          Type: 'fixed-response',
          FixedResponseConfig: { StatusCode: '404' },
        }),
      ]),
    });
  });

  test('creates an ALB security group', () => {
    template.resourceCountIs('AWS::EC2::SecurityGroup', 1);
  });
});

describe('EcsFargateAlbComputeStack', () => {
  const app = new cdk.App();
  const vpcStack = new VpcSubnetsStack(app, 'VpcStack2');
  const clusterStack = new EcsClusterStack(app, 'ClusterStack', {
    vpc: vpcStack.vpc,
  });
  const networkingStack = new EcsFargateAlbNetworkingStack(app, 'NetworkingStack2', {
    vpc: vpcStack.vpc,
  });
  const stack = new EcsFargateAlbComputeStack(app, 'ComputeStack', {
    vpc: vpcStack.vpc,
    cluster: clusterStack.cluster,
    listener: networkingStack.listener,
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

  test('creates a target group on port 3000 with IP target type', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      Port: 3000,
      TargetType: 'ip',
    });
  });

  test('creates a listener rule for /quote-service paths with priority 100', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Priority: 100,
      Conditions: Match.arrayWith([
        Match.objectLike({
          Field: 'path-pattern',
          PathPatternConfig: { Values: ['/quote-service', '/quote-service/*'] },
        }),
      ]),
    });
  });

  test('creates ALB-to-task security group ingress', () => {
    template.resourceCountIs('AWS::EC2::SecurityGroup', 1);
    // CDK Connections tracking auto-generates this rule via attachToApplicationTargetGroup
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      Description: 'Load balancer to target',
      FromPort: 3000,
      ToPort: 3000,
    });
  });
});

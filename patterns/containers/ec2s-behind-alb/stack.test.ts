import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { VpcSubnetsStack } from '../../vpc-subnets/stack';
import { Ec2sAlbNetworkingStack } from './stack_networking';
import { Ec2sAlbComputeStack } from './stack_compute';

describe('Ec2sAlbNetworkingStack', () => {
  const app = new cdk.App();
  const vpcStack = new VpcSubnetsStack(app, 'VpcStack');
  const stack = new Ec2sAlbNetworkingStack(app, 'NetworkingStack', {
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

describe('Ec2sAlbComputeStack', () => {
  const app = new cdk.App();
  const vpcStack = new VpcSubnetsStack(app, 'VpcStack2');
  const networkingStack = new Ec2sAlbNetworkingStack(app, 'NetworkingStack2', {
    vpc: vpcStack.vpc,
  });
  const stack = new Ec2sAlbComputeStack(app, 'ComputeStack', {
    vpc: vpcStack.vpc,
    listener: networkingStack.listener,
  });
  const template = Template.fromStack(stack);

  test('creates a launch template with t4g.micro instance type', () => {
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: Match.objectLike({
        InstanceType: 't4g.micro',
      }),
    });
  });

  test('creates an ASG with min=1, max=4', () => {
    template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      MinSize: '1',
      MaxSize: '4',
    });
  });

  test('creates a target group on port 3000 with instance target type', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      Port: 3000,
      TargetType: 'instance',
    });
  });

  test('creates a listener rule for /ec2s-alb paths with priority 200', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Priority: 200,
      Conditions: Match.arrayWith([
        Match.objectLike({
          Field: 'path-pattern',
          PathPatternConfig: { Values: ['/ec2s-alb', '/ec2s-alb/*'] },
        }),
      ]),
    });
  });

  test('creates ALB-to-instance security group ingress on port 3000', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      Description: 'Load balancer to target',
      FromPort: 3000,
      ToPort: 3000,
    });
  });

  test('creates a CloudWatch log group named /ec2/ec2s-behind-alb', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ec2/ec2s-behind-alb',
    });
  });
});

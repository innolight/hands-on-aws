import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { VpcSubnetsStack } from '../vpc-subnets/stack';
import { SsmBastionStack } from './stack';

describe('SsmBastionStack', () => {
  const app = new cdk.App();
  const vpcStack = new VpcSubnetsStack(app, 'VpcStack');
  const stack = new SsmBastionStack(app, 'TestStack', { vpc: vpcStack.vpc });
  const template = Template.fromStack(stack);

  test('creates 1 EC2 instance', () => {
    template.resourceCountIs('AWS::EC2::Instance', 1);
  });

  test('creates 1 security group (bastion SG — no inbound)', () => {
    template.resourceCountIs('AWS::EC2::SecurityGroup', 1);
  });

  test('creates IAM role with AmazonSSMManagedInstanceCore', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      ManagedPolicyArns: [
        {
          'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::aws:policy/AmazonSSMManagedInstanceCore']],
        },
      ],
    });
  });
});

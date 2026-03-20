import * as cdk from 'aws-cdk-lib';
import {Match, Template} from 'aws-cdk-lib/assertions';
import {VpcSubnetsStack} from './stack';

describe('VpcSubnetsStack', () => {
  describe('default (natGateways=0)', () => {
    const app = new cdk.App();
    const stack = new VpcSubnetsStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    // Without a real env, CDK's dummy environment resolves to 2 AZs, so maxAzs=3 is capped at 2.
    // 2 AZs × 3 tiers = 6 subnets.
    test('creates 6 subnets (3 tiers × 2 AZs in test env)', () => {
      template.resourceCountIs('AWS::EC2::Subnet', 6);
    });

    test('creates 1 Internet Gateway', () => {
      template.resourceCountIs('AWS::EC2::InternetGateway', 1);
    });

    test('creates no NAT Gateways', () => {
      template.resourceCountIs('AWS::EC2::NatGateway', 0);
    });

    test('creates no Elastic IPs (no NAT GW)', () => {
      template.resourceCountIs('AWS::EC2::EIP', 0);
    });
  });

  describe('natGateways=1, aws-managed', () => {
    const app = new cdk.App({'context': {natGateways: '1'}});
    const stack = new VpcSubnetsStack(app, 'TestStack', {natProviderType: 'aws-managed'});
    const template = Template.fromStack(stack);

    test('creates 1 NAT Gateway', () => {
      template.resourceCountIs('AWS::EC2::NatGateway', 1);
    });

    test('creates 1 Elastic IP for NAT Gateway', () => {
      template.resourceCountIs('AWS::EC2::EIP', 1);
    });
  });

  describe('natGateways=3, aws-managed', () => {
    const app = new cdk.App({'context': {natGateways: '3'}});
    const stack = new VpcSubnetsStack(app, 'TestStack', {natProviderType: 'aws-managed'});
    const template = Template.fromStack(stack);

    // natGateways=3 is capped to the AZ count (2 in test env).
    test('creates 2 NAT Gateways (capped to AZ count in test env)', () => {
      template.resourceCountIs('AWS::EC2::NatGateway', 2);
    });

    test('creates 2 Elastic IPs (one per NAT GW)', () => {
      template.resourceCountIs('AWS::EC2::EIP', 2);
    });
  });

  describe('natGateways=1, self-managed (default)', () => {
    const app = new cdk.App({'context': {natGateways: '1'}});
    // natProviderType defaults to 'self-managed'
    const stack = new VpcSubnetsStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    test('creates 1 EC2 NAT instance', () => {
      template.resourceCountIs('AWS::EC2::Instance', 1);
    });

    test('creates no managed NAT Gateways', () => {
      template.resourceCountIs('AWS::EC2::NatGateway', 0);
    });

    test('NAT instance SG allows ingress from VPC CIDR', () => {
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupDescription: 'Security Group for NAT instances',
        SecurityGroupIngress: Match.arrayWith([
          Match.objectLike({
            CidrIp: Match.objectLike({'Fn::GetAtt': Match.arrayWith(['Vpc8378EB38', 'CidrBlock'])}),
            IpProtocol: '-1',
          }),
        ]),
      });
    });
  });
});

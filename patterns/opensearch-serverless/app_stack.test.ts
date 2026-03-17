import * as cdk from 'aws-cdk-lib';
import {Template, Match} from 'aws-cdk-lib/assertions';
import {VpcSubnetsStack} from '../vpc-subnets/stack';
import {SsmBastionStack} from '../ssm-bastion/stack';
import {OpenSearchServerlessStack} from './stack';
import {OpenSearchServerlessAppStack} from './app_stack';

describe('OpenSearchServerlessAppStack', () => {
  const app = new cdk.App();
  const vpcStack = new VpcSubnetsStack(app, 'VpcStack');
  const bastionStack = new SsmBastionStack(app, 'BastionStack', {vpc: vpcStack.vpc});
  const ossStack = new OpenSearchServerlessStack(app, 'OssStack', {vpc: vpcStack.vpc});
  const stack = new OpenSearchServerlessAppStack(app, 'TestStack', {
    bastionSG: bastionStack.bastionSG,
    vpcEndpointSG: ossStack.vpcEndpointSG,
  });
  const template = Template.fromStack(stack);

  test('creates a CfnSecurityGroupIngress for HTTPS (443) from bastion to VPC endpoint SG', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 443,
      ToPort: 443,
      SourceSecurityGroupId: Match.anyValue(),
      GroupId: Match.anyValue(),
    });
  });

  test('contains exactly one CfnSecurityGroupIngress', () => {
    template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 1);
  });
});

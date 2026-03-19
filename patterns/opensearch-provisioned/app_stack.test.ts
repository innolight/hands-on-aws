import * as cdk from 'aws-cdk-lib';
import {Template, Match} from 'aws-cdk-lib/assertions';
import {VpcSubnetsStack} from '../vpc-subnets/stack';
import {SsmBastionStack} from '../ssm-bastion/stack';
import {OpenSearchProvisionedStack} from './stack';
import {OpenSearchProvisionedAppStack} from './app_stack';

describe('OpenSearchProvisionedAppStack', () => {
  const app = new cdk.App();
  const vpcStack = new VpcSubnetsStack(app, 'VpcStack');
  const bastionStack = new SsmBastionStack(app, 'BastionStack', {vpc: vpcStack.vpc});
  const ospStack = new OpenSearchProvisionedStack(app, 'OspStack', {vpc: vpcStack.vpc});
  const stack = new OpenSearchProvisionedAppStack(app, 'TestStack', {
    bastionSG: bastionStack.bastionSG,
    domainSG: ospStack.domainSG,
  });
  const template = Template.fromStack(stack);

  test('creates a CfnSecurityGroupIngress for HTTPS (443) from bastion to domain SG', () => {
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

import * as cdk from 'aws-cdk-lib';
import {Template} from 'aws-cdk-lib/assertions';
import {VpcSubnetsStack} from '../vpc-subnets/stack';
import {OpenSearchServerlessStack} from './stack';

describe('OpenSearchServerlessStack', () => {
  const app = new cdk.App();
  const vpcStack = new VpcSubnetsStack(app, 'VpcStack');
  const stack = new OpenSearchServerlessStack(app, 'TestStack', {
    vpc: vpcStack.vpc,
  });
  const template = Template.fromStack(stack);

  test('creates a SEARCH collection with standby replicas disabled', () => {
    template.hasResourceProperties('AWS::OpenSearchServerless::Collection', {
      Type: 'SEARCH',
      StandbyReplicas: 'DISABLED',
    });
  });

  test('creates encryption, network security policies and a data access policy', () => {
    template.resourceCountIs('AWS::OpenSearchServerless::SecurityPolicy', 2);
    template.resourceCountIs('AWS::OpenSearchServerless::AccessPolicy', 1);
  });

  test('creates a VPC endpoint and its security group', () => {
    template.resourceCountIs('AWS::OpenSearchServerless::VpcEndpoint', 1);
    template.resourceCountIs('AWS::EC2::SecurityGroup', 1);
  });
});

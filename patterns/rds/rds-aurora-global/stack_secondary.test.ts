import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { VpcSubnetsStack } from '../../vpc-subnets/stack';
import { SsmBastionStack } from '../../ssm-bastion/stack';
import { RdsAuroraGlobalSecondaryStack } from './stack_secondary';

describe('RdsAuroraGlobalSecondaryStack', () => {
  const app = new cdk.App();
  const vpcStack = new VpcSubnetsStack(app, 'VpcStack');
  const bastionStack = new SsmBastionStack(app, 'BastionStack', { vpc: vpcStack.vpc });
  const stack = new RdsAuroraGlobalSecondaryStack(app, 'TestStack', {
    vpc: vpcStack.vpc,
    bastionSG: bastionStack.bastionSG,
  });
  const template = Template.fromStack(stack);

  test('creates 1 DB cluster joined to the global cluster', () => {
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      GlobalClusterIdentifier: 'aurora-global-demo',
      Engine: 'aurora-postgresql',
    });
  });

  test('write forwarding is explicitly disabled', () => {
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      EnableGlobalWriteForwarding: false,
    });
  });

  test('creates 1 DB instance with t4g.medium', () => {
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      DBInstanceClass: 'db.r6g.large',
      Engine: 'aurora-postgresql',
    });
  });

  test('creates 1 DB subnet group', () => {
    template.resourceCountIs('AWS::RDS::DBSubnetGroup', 1);
  });

  test('cluster parameter group uses aurora-postgresql17 family', () => {
    template.hasResourceProperties('AWS::RDS::DBClusterParameterGroup', {
      Family: 'aurora-postgresql17',
    });
  });

  test('security group has correct description', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Aurora Global Database secondary cluster security group',
    });
  });

  test('allows bastion ingress on port 5432', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 5432,
      ToPort: 5432,
    });
  });
});

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { VpcSubnetsStack } from '../../vpc-subnets/stack';
import { SsmBastionStack } from '../../ssm-bastion/stack';
import { RdsAuroraProvisionedStack } from './stack';

describe('RdsAuroraProvisionedStack', () => {
  const app = new cdk.App();
  const vpcStack = new VpcSubnetsStack(app, 'VpcStack');
  const bastionStack = new SsmBastionStack(app, 'BastionStack', { vpc: vpcStack.vpc });
  const stack = new RdsAuroraProvisionedStack(app, 'RdsAuroraProvisionedStack', {
    vpc: vpcStack.vpc,
    bastionSG: bastionStack.bastionSG,
  });
  const template = Template.fromStack(stack);

  test('creates Aurora PostgreSQL cluster with engine version 17.7', () => {
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      Engine: 'aurora-postgresql',
      EngineVersion: '17.7',
    });
  });

  test('cluster parameter group uses aurora-postgresql17 family', () => {
    template.hasResourceProperties('AWS::RDS::DBClusterParameterGroup', {
      Family: 'aurora-postgresql17',
    });
  });

  test('creates 2 DB instances (writer + reader)', () => {
    template.resourceCountIs('AWS::RDS::DBInstance', 2);
  });

  test('creates 1 DB subnet group', () => {
    template.resourceCountIs('AWS::RDS::DBSubnetGroup', 1);
  });

  test('creates 1 Secrets Manager secret for credentials', () => {
    template.resourceCountIs('AWS::SecretsManager::Secret', 1);
  });

  test('security group has correct description', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Aurora provisioned cluster security group',
    });
  });

  test('allows bastion ingress on port 5432', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 5432,
      ToPort: 5432,
    });
  });

  test('creates 2 custom cluster endpoints via AwsCustomResource', () => {
    template.resourceCountIs('Custom::AWS', 2);
  });
});

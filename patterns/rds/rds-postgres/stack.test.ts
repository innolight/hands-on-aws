import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { VpcSubnetsStack } from '../../vpc-subnets/stack';
import { SsmBastionStack } from '../../ssm-bastion/stack';
import { RdsPostgresStack } from './stack';

describe('RdsPostgresStack', () => {
  const app = new cdk.App();
  const vpcStack = new VpcSubnetsStack(app, 'VpcStack');
  const bastionStack = new SsmBastionStack(app, 'BastionStack', { vpc: vpcStack.vpc });
  const stack = new RdsPostgresStack(app, 'RdsPostgresStack', {
    vpc: vpcStack.vpc,
    bastionSG: bastionStack.bastionSG,
  });
  const template = Template.fromStack(stack);

  test('creates a custom parameter group with postgres17 family', () => {
    template.hasResourceProperties('AWS::RDS::DBParameterGroup', {
      Family: 'postgres17',
    });
  });

  test('creates a PostgreSQL 17 database instance', () => {
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      EngineVersion: '17.7',
      MultiAZ: false,
    });
  });

  test('places instance in a DB subnet group', () => {
    template.resourceCountIs('AWS::RDS::DBSubnetGroup', 1);
  });

  test('creates an RDS Proxy', () => {
    template.resourceCountIs('AWS::RDS::DBProxy', 1);
  });

  test('proxy requires TLS', () => {
    template.hasResourceProperties('AWS::RDS::DBProxy', {
      RequireTLS: true,
    });
  });

  test('creates a Secrets Manager secret for credentials', () => {
    template.resourceCountIs('AWS::SecretsManager::Secret', 1);
  });

  test('creates a security group with no default ingress on the DB SG', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'RDS PostgreSQL security group',
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

describe('RdsPostgresStack with multiAz=true', () => {
  const app2 = new cdk.App({ context: { multiAz: 'true' } });
  const vpcStack2 = new VpcSubnetsStack(app2, 'VpcStack2');
  const bastionStack2 = new SsmBastionStack(app2, 'BastionStack2', { vpc: vpcStack2.vpc });
  const stack2 = new RdsPostgresStack(app2, 'RdsPostgresStack2', {
    vpc: vpcStack2.vpc,
    bastionSG: bastionStack2.bastionSG,
  });
  const template2 = Template.fromStack(stack2);

  test('enables Multi-AZ when context multiAz=true', () => {
    template2.hasResourceProperties('AWS::RDS::DBInstance', {
      MultiAZ: true,
    });
  });
});

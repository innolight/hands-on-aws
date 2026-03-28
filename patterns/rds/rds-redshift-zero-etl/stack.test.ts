import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { VpcSubnetsStack } from '../../vpc-subnets/stack';
import { SsmBastionStack } from '../../ssm-bastion/stack';
import { RdsRedshiftZeroEtlRdsStack } from './stack_rds';
import { RdsRedshiftProvisionedStack } from './stack_redshift_provisioned';
import { RdsRedshiftIntegrationStack } from './stack_integration';

describe('RdsRedshiftZeroEtlRdsStack', () => {
  const app = new cdk.App();
  const vpcStack = new VpcSubnetsStack(app, 'VpcStack');
  const bastionStack = new SsmBastionStack(app, 'BastionStack', { vpc: vpcStack.vpc });
  const rdsStack = new RdsRedshiftZeroEtlRdsStack(app, 'RdsStack', {
    vpc: vpcStack.vpc,
    bastionSG: bastionStack.bastionSG,
  });
  const template = Template.fromStack(rdsStack);

  test('creates PostgreSQL 17.7 instance', () => {
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      EngineVersion: '17.7',
    });
  });

  test('creates exactly 1 DB instance', () => {
    template.resourceCountIs('AWS::RDS::DBInstance', 1);
  });

  test('instance is Single-AZ', () => {
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      MultiAZ: false,
    });
  });

  test('parameter group enables logical replication and replica identity full', () => {
    template.hasResourceProperties('AWS::RDS::DBParameterGroup', {
      Parameters: Match.objectLike({
        'rds.logical_replication': '1',
        'rds.replica_identity_full': '1',
      }),
    });
  });

  test('allows bastion ingress on port 5432', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 5432,
      ToPort: 5432,
    });
  });

  test('creates 1 Secrets Manager secret for credentials', () => {
    template.resourceCountIs('AWS::SecretsManager::Secret', 1);
  });
});

describe('RdsRedshiftProvisionedStack', () => {
  const app = new cdk.App();
  const vpcStack = new VpcSubnetsStack(app, 'VpcStack3');
  const bastionStack = new SsmBastionStack(app, 'BastionStack3', { vpc: vpcStack.vpc });
  const rdsStack = new RdsRedshiftZeroEtlRdsStack(app, 'RdsStack3', {
    vpc: vpcStack.vpc,
    bastionSG: bastionStack.bastionSG,
  });
  const stack = new RdsRedshiftProvisionedStack(app, 'ProvisionedStack', {
    rdsInstance: rdsStack.instance,
    vpc: vpcStack.vpc,
  });
  const template = Template.fromStack(stack);

  test('creates ra3.large single-node cluster', () => {
    template.hasResourceProperties('AWS::Redshift::Cluster', {
      NodeType: 'ra3.large',
      ClusterType: 'single-node',
    });
  });

  test('parameter group enables case-sensitive identifiers', () => {
    template.hasResourceProperties('AWS::Redshift::ClusterParameterGroup', {
      Parameters: Match.arrayWith([{ ParameterName: 'enable_case_sensitive_identifier', ParameterValue: 'true' }]),
    });
  });
});

describe('RdsRedshiftIntegrationStack', () => {
  const app = new cdk.App();
  const vpcStack = new VpcSubnetsStack(app, 'VpcStack4');
  const bastionStack = new SsmBastionStack(app, 'BastionStack4', { vpc: vpcStack.vpc });
  const rdsStack = new RdsRedshiftZeroEtlRdsStack(app, 'RdsStack4', {
    vpc: vpcStack.vpc,
    bastionSG: bastionStack.bastionSG,
  });
  const provisionedStack = new RdsRedshiftProvisionedStack(app, 'ProvisionedStack4', {
    rdsInstance: rdsStack.instance,
    vpc: vpcStack.vpc,
  });
  const stack = new RdsRedshiftIntegrationStack(app, 'IntegrationStack', {
    rdsInstance: rdsStack.instance,
    clusterArn: provisionedStack.clusterArn,
    namespaceArn: provisionedStack.namespaceArn,
  });
  const template = Template.fromStack(stack);

  test('creates exactly 1 RDS integration', () => {
    template.resourceCountIs('AWS::RDS::Integration', 1);
  });

  test('integration name is set', () => {
    template.hasResourceProperties('AWS::RDS::Integration', {
      IntegrationName: 'rds-to-redshift-provisioned',
    });
  });

  test('creates custom resource to set Redshift cluster resource policy', () => {
    template.resourceCountIs('Custom::AWS', 1);
  });

  test('resource policy custom resource is present', () => {
    template.hasResourceProperties('Custom::AWS', {
      Create: Match.objectLike({
        'Fn::Join': Match.anyValue(),
      }),
    });
  });

  test('RDS integration depends on resource policy', () => {
    const integration = template.findResources('AWS::RDS::Integration');
    const resourcePolicyId = Object.keys(template.findResources('Custom::AWS'))[0];
    const integrationId = Object.keys(integration)[0];

    expect(integration[integrationId].DependsOn).toContain(resourcePolicyId);
  });
});

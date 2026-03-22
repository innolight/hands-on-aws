import * as cdk from 'aws-cdk-lib';
import {Template} from 'aws-cdk-lib/assertions';
import {VpcSubnetsStack} from '../../vpc-subnets/stack';
import {SsmBastionStack} from '../../ssm-bastion/stack';
import {RdsReadableStandbysStack} from './stack';

describe('RdsReadableStandbysStack', () => {
  const app = new cdk.App();
  const vpcStack = new VpcSubnetsStack(app, 'VpcStack');
  const bastionStack = new SsmBastionStack(app, 'BastionStack', {vpc: vpcStack.vpc});
  const stack = new RdsReadableStandbysStack(app, 'RdsReadableStandbysStack', {
    vpc: vpcStack.vpc,
    bastionSG: bastionStack.bastionSG,
  });
  const template = Template.fromStack(stack);

  test('creates a Multi-AZ DB cluster with postgres engine', () => {
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      Engine: 'postgres',
      EngineVersion: '17.7',
    });
  });

  test('uses db.m5d.large cluster instance class', () => {
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      DBClusterInstanceClass: 'db.m5d.large',
    });
  });

  test('uses io1 storage with minimum 100 GiB', () => {
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      StorageType: 'io1',
      AllocatedStorage: 100,
    });
  });

  test('uses managed master user password', () => {
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      ManageMasterUserPassword: true,
    });
  });

  test('creates a DB subnet group', () => {
    template.resourceCountIs('AWS::RDS::DBSubnetGroup', 1);
  });

  test('allows bastion ingress on port 5432', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 5432,
      ToPort: 5432,
    });
  });
});

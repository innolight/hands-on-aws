import * as cdk from 'aws-cdk-lib';
import {Template} from 'aws-cdk-lib/assertions';
import {VpcSubnetsStack} from '../../vpc-subnets/stack';
import {SsmBastionStack} from '../../ssm-bastion/stack';
import {RdsReadReplicasStack} from './stack';
import {RdsReadReplicasProxyStack} from './stack_proxy';

describe('RdsReadReplicasStack', () => {
  const app = new cdk.App();
  const vpcStack = new VpcSubnetsStack(app, 'VpcStack');
  const stack = new RdsReadReplicasStack(app, 'RdsReadReplicasStack', {
    vpc: vpcStack.vpc,
  });
  const template = Template.fromStack(stack);

  test('defaults to one replica (primary + 1 replica)', () => {
    template.resourceCountIs('AWS::RDS::DBInstance', 2);
  });

  test('primary is a PostgreSQL 17 instance', () => {
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      EngineVersion: '17.7',
    });
  });

  test('replica references the primary via SourceDBInstanceIdentifier', () => {
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      SourceDBInstanceIdentifier: {},
    });
  });

  test('each instance gets its own subnet group', () => {
    template.resourceCountIs('AWS::RDS::DBSubnetGroup', 2);
  });

  test('creates a Secrets Manager secret for primary credentials', () => {
    template.resourceCountIs('AWS::SecretsManager::Secret', 1);
  });

  test('has no security group ingress rules (proxy stack owns ingress)', () => {
    template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
  });
});

describe('RdsReadReplicasStack with replicaCount=3', () => {
  const app = new cdk.App();
  const vpcStack = new VpcSubnetsStack(app, 'VpcStack3');
  const stack = new RdsReadReplicasStack(app, 'RdsReadReplicasStack3', {
    vpc: vpcStack.vpc,
    replicaCount: 3,
  });
  const template = Template.fromStack(stack);

  test('creates 4 DB instances (primary + 3 replicas)', () => {
    template.resourceCountIs('AWS::RDS::DBInstance', 4);
  });

  test('each instance gets its own subnet group', () => {
    template.resourceCountIs('AWS::RDS::DBSubnetGroup', 4);
  });
});

describe('RdsReadReplicasStack validation', () => {
  const app = new cdk.App();
  const vpcStack = new VpcSubnetsStack(app, 'VpcStackV');

  test('throws on replicaCount = 0', () => {
    expect(() => new RdsReadReplicasStack(app, 'Zero', {
      vpc: vpcStack.vpc, replicaCount: 0,
    })).toThrow(/replicaCount must be an integer between 1 and 15/);
  });

  test('throws on replicaCount = 16', () => {
    expect(() => new RdsReadReplicasStack(app, 'TooMany', {
      vpc: vpcStack.vpc, replicaCount: 16,
    })).toThrow(/replicaCount must be an integer between 1 and 15/);
  });

  test('throws on non-integer replicaCount', () => {
    expect(() => new RdsReadReplicasStack(app, 'Float', {
      vpc: vpcStack.vpc, replicaCount: 2.5,
    })).toThrow(/replicaCount must be an integer between 1 and 15/);
  });
});

describe('RdsReadReplicasProxyStack', () => {
  const app = new cdk.App();
  const vpcStack = new VpcSubnetsStack(app, 'VpcStackP');
  const bastionStack = new SsmBastionStack(app, 'BastionStackP', {vpc: vpcStack.vpc});
  const rdsStack = new RdsReadReplicasStack(app, 'RdsStackP', {vpc: vpcStack.vpc});
  const stack = new RdsReadReplicasProxyStack(app, 'ProxyStack', {
    vpc: vpcStack.vpc,
    bastionSG: bastionStack.bastionSG,
    primary: rdsStack.primary,
    dbSG: rdsStack.dbSG,
  });
  const template = Template.fromStack(stack);

  test('creates one RDS Proxy', () => {
    template.resourceCountIs('AWS::RDS::DBProxy', 1);
  });

  test('proxy targets POSTGRESQL engine family', () => {
    template.hasResourceProperties('AWS::RDS::DBProxy', {
      EngineFamily: 'POSTGRESQL',
    });
  });

  test('creates a read-only proxy endpoint', () => {
    template.resourceCountIs('AWS::RDS::DBProxyEndpoint', 1);
    template.hasResourceProperties('AWS::RDS::DBProxyEndpoint', {
      TargetRole: 'READ_ONLY',
    });
  });

  test('has 2 security group ingress rules (bastion→proxy, proxy→db)', () => {
    template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 2);
  });

  test('bastion can reach proxy on port 5432', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 5432,
      ToPort: 5432,
    });
  });
});

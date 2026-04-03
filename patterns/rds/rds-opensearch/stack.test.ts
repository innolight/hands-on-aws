import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { VpcSubnetsStack } from '../../vpc-subnets/stack';
import { SsmBastionStack } from '../../ssm-bastion/stack';
import { RdsOpensearchRdsStack } from './stack_rds';
import { RdsOpensearchOpenSearchStack } from './stack_opensearch';
import { RdsOpensearchPipelineStack } from './stack_pipeline';

describe('RdsOpensearchRdsStack', () => {
  const app = new cdk.App();
  const vpcStack = new VpcSubnetsStack(app, 'VpcStack');
  const bastionStack = new SsmBastionStack(app, 'BastionStack', { vpc: vpcStack.vpc });
  const rdsStack = new RdsOpensearchRdsStack(app, 'RdsStack', {
    vpc: vpcStack.vpc,
    bastionSG: bastionStack.bastionSG,
  });
  const template = Template.fromStack(rdsStack);

  test('creates a PostgreSQL 17 database instance', () => {
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      EngineVersion: '17.7',
    });
  });

  test('creates exactly 1 DB instance', () => {
    template.resourceCountIs('AWS::RDS::DBInstance', 1);
  });

  test('parameter group enables logical replication', () => {
    template.hasResourceProperties('AWS::RDS::DBParameterGroup', {
      Parameters: Match.objectLike({
        'rds.logical_replication': '1',
        wal_sender_timeout: '0',
        max_wal_senders: '10',
        max_replication_slots: '10',
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

describe('RdsOpensearchOpenSearchStack', () => {
  const app = new cdk.App();
  const vpcStack = new VpcSubnetsStack(app, 'VpcStack2');
  const osStack = new RdsOpensearchOpenSearchStack(app, 'OpenSearchStack', {
    vpc: vpcStack.vpc,
  });
  const template = Template.fromStack(osStack);

  test('creates an OpenSearch 2.x domain', () => {
    template.hasResourceProperties('AWS::OpenSearchService::Domain', {
      EngineVersion: 'OpenSearch_2.19',
    });
  });

  test('domain has 2 data nodes', () => {
    template.hasResourceProperties('AWS::OpenSearchService::Domain', {
      ClusterConfig: Match.objectLike({
        InstanceCount: 2,
        InstanceType: 't3.small.search',
        ZoneAwarenessEnabled: true,
      }),
    });
  });

  test('domain enforces HTTPS and encryption at rest', () => {
    template.hasResourceProperties('AWS::OpenSearchService::Domain', {
      DomainEndpointOptions: Match.objectLike({ EnforceHTTPS: true }),
      EncryptionAtRestOptions: Match.objectLike({ Enabled: true }),
      NodeToNodeEncryptionOptions: Match.objectLike({ Enabled: true }),
    });
  });

  test('domain is VPC-attached with a security group', () => {
    template.hasResourceProperties('AWS::OpenSearchService::Domain', {
      VPCOptions: Match.objectLike({
        SecurityGroupIds: Match.anyValue(),
        SubnetIds: Match.anyValue(),
      }),
    });
  });
});

describe('RdsOpensearchPipelineStack', () => {
  const app = new cdk.App();
  const vpcStack = new VpcSubnetsStack(app, 'VpcStack3');
  const bastionStack = new SsmBastionStack(app, 'BastionStack3', { vpc: vpcStack.vpc });
  const rdsStack = new RdsOpensearchRdsStack(app, 'RdsStack3', {
    vpc: vpcStack.vpc,
    bastionSG: bastionStack.bastionSG,
  });
  const osStack = new RdsOpensearchOpenSearchStack(app, 'OpenSearchStack3', {
    vpc: vpcStack.vpc,
  });
  const pipelineStack = new RdsOpensearchPipelineStack(app, 'PipelineStack', {
    vpc: vpcStack.vpc,
    rdsInstance: rdsStack.instance,
    rdsSecret: rdsStack.secret,
    rdsSG: rdsStack.dbSG,
    opensearchDomain: osStack.domain,
    opensearchDomainSG: osStack.domainSG,
  });
  const template = Template.fromStack(pipelineStack);

  test('creates an OSI pipeline', () => {
    template.resourceCountIs('AWS::OSIS::Pipeline', 1);
  });

  test('pipeline has correct name and unit range', () => {
    template.hasResourceProperties('AWS::OSIS::Pipeline', {
      PipelineName: 'rds-opensearch-cdc',
      MinUnits: 1,
      MaxUnits: 4,
    });
  });

  test('pipeline is attached to VPC', () => {
    template.hasResourceProperties('AWS::OSIS::Pipeline', {
      VpcOptions: Match.objectLike({
        SubnetIds: Match.anyValue(),
        SecurityGroupIds: Match.anyValue(),
      }),
    });
  });

  test('creates an S3 bucket for snapshots with SSL enforced', () => {
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 's3:*',
            Condition: Match.objectLike({ Bool: { 'aws:SecureTransport': 'false' } }),
            Effect: 'Deny',
          }),
        ]),
      }),
    });
  });

  test('creates a KMS key with rotation enabled', () => {
    template.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
    });
  });

  test('creates an export IAM role trusted by RDS export service', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'export.rds.amazonaws.com' },
          }),
        ]),
      }),
    });
  });

  test('creates a pipeline IAM role trusted by OSI', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'osis-pipelines.amazonaws.com' },
          }),
        ]),
      }),
    });
  });

  test('adds ingress rules on RDS and OpenSearch SGs (2 CfnSecurityGroupIngress resources)', () => {
    template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 2);
  });

  test('pipeline SG has egress to port 5432 and 443', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupEgress: Match.arrayWith([
        Match.objectLike({ IpProtocol: 'tcp', FromPort: 5432, ToPort: 5432 }),
        Match.objectLike({ IpProtocol: 'tcp', FromPort: 443, ToPort: 443 }),
      ]),
    });
  });
});

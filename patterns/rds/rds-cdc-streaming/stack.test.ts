import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { VpcSubnetsStack } from '../../vpc-subnets/stack';
import { SsmBastionStack } from '../../ssm-bastion/stack';
import { RdsCdcStreamingRdsStack } from './stack_rds';
import { RdsCdcStreamingDmsStack } from './stack_dms';
import { RdsCdcStreamingLambdaStack } from './stack_lambda';

describe('RdsCdcStreamingRdsStack', () => {
  const app = new cdk.App();
  const vpcStack = new VpcSubnetsStack(app, 'VpcStack');
  const bastionStack = new SsmBastionStack(app, 'BastionStack', { vpc: vpcStack.vpc });
  const rdsStack = new RdsCdcStreamingRdsStack(app, 'RdsStack', {
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

describe('RdsCdcStreamingDmsStack', () => {
  const app = new cdk.App();
  const vpcStack = new VpcSubnetsStack(app, 'VpcStack2');
  const bastionStack = new SsmBastionStack(app, 'BastionStack2', { vpc: vpcStack.vpc });
  const rdsStack = new RdsCdcStreamingRdsStack(app, 'RdsStack2', {
    vpc: vpcStack.vpc,
    bastionSG: bastionStack.bastionSG,
  });
  const dmsStack = new RdsCdcStreamingDmsStack(app, 'DmsStack', {
    vpc: vpcStack.vpc,
    rdsInstance: rdsStack.instance,
    rdsSecret: rdsStack.secret,
    rdsSG: rdsStack.dbSG,
  });
  const template = Template.fromStack(dmsStack);

  test('creates a Kinesis stream with 1 shard in provisioned mode', () => {
    template.hasResourceProperties('AWS::Kinesis::Stream', {
      ShardCount: 1,
      StreamModeDetails: { StreamMode: 'PROVISIONED' },
    });
  });

  test('creates a DMS replication instance (t3.micro, 50 GB)', () => {
    template.hasResourceProperties('AWS::DMS::ReplicationInstance', {
      ReplicationInstanceClass: 'dms.t3.micro',
      AllocatedStorage: 50,
      PubliclyAccessible: false,
      MultiAZ: false,
    });
  });

  test('creates a DMS replication subnet group', () => {
    template.resourceCountIs('AWS::DMS::ReplicationSubnetGroup', 1);
  });

  test('creates a PostgreSQL source endpoint', () => {
    template.hasResourceProperties('AWS::DMS::Endpoint', {
      EndpointType: 'source',
      EngineName: 'postgres',
      DatabaseName: 'demo',
      Port: 5432,
    });
  });

  test('creates a Kinesis target endpoint', () => {
    template.hasResourceProperties('AWS::DMS::Endpoint', {
      EndpointType: 'target',
      EngineName: 'kinesis',
      KinesisSettings: Match.objectLike({
        MessageFormat: 'json',
        IncludeTransactionDetails: true,
        PartitionIncludeSchemaTable: true,
      }),
    });
  });

  test('creates a full-load-and-cdc replication task', () => {
    template.hasResourceProperties('AWS::DMS::ReplicationTask', {
      MigrationType: 'full-load-and-cdc',
    });
  });

  test('creates an IAM role for DMS to write to Kinesis', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'dms.amazonaws.com' },
          }),
        ]),
      }),
    });
  });

  test('DMS → RDS security group ingress rule exists on port 5432', () => {
    // This ingress rule is added to the RDS SG from the DMS stack
    template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 1);
  });
});

describe('RdsCdcStreamingLambdaStack', () => {
  const app = new cdk.App();
  const vpcStack = new VpcSubnetsStack(app, 'VpcStack3');
  const bastionStack = new SsmBastionStack(app, 'BastionStack3', { vpc: vpcStack.vpc });
  const rdsStack = new RdsCdcStreamingRdsStack(app, 'RdsStack3', {
    vpc: vpcStack.vpc,
    bastionSG: bastionStack.bastionSG,
  });
  const dmsStack = new RdsCdcStreamingDmsStack(app, 'DmsStack3', {
    vpc: vpcStack.vpc,
    rdsInstance: rdsStack.instance,
    rdsSecret: rdsStack.secret,
    rdsSG: rdsStack.dbSG,
  });
  const lambdaStack = new RdsCdcStreamingLambdaStack(app, 'LambdaStack', {
    stream: dmsStack.stream,
  });
  const template = Template.fromStack(lambdaStack);

  test('creates a Lambda function', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'rds-cdc-processor',
      Runtime: 'nodejs20.x',
    });
  });

  test('creates a DynamoDB dedup table with TTL', () => {
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      TableName: 'rds-cdc-dedup',
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    });
  });

  test('creates an SQS DLQ', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'rds-cdc-dlq',
    });
  });

  test('event source mapping has bisectBatchOnFunctionError and reportBatchItemFailures', () => {
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BisectBatchOnFunctionError: true,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      StartingPosition: 'TRIM_HORIZON',
      BatchSize: 10,
    });
  });
});

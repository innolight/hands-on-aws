import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dms from 'aws-cdk-lib/aws-dms';

export const rdsCdcStreamingDmsStackName = 'RdsCdcStreamingDms';

interface RdsCdcStreamingDmsStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  rdsInstance: rds.DatabaseInstance;
  rdsSecret: secretsmanager.ISecret;
  rdsSG: ec2.SecurityGroup;
}

// DMS reads WAL from RDS via logical replication → writes CDC events to Kinesis as JSON
export class RdsCdcStreamingDmsStack extends cdk.Stack {
  public readonly stream: kinesis.Stream;

  constructor(scope: Construct, id: string, props: RdsCdcStreamingDmsStackProps) {
    super(scope, id, props);

    // --- Kinesis Data Stream ---

    // Provisioned mode with 1 shard: makes the shard model concrete for learning.
    // One shard handles up to 1 000 records/s and 1 MB/s writes — more than enough for demo.
    // Monitor WriteProvisionedThroughputExceeded; add shards when it's non-zero at sustained load.
    this.stream = new kinesis.Stream(this, 'CdcStream', {
      streamName: 'rds-cdc-stream',
      shardCount: 1,
      streamMode: kinesis.StreamMode.PROVISIONED,
      retentionPeriod: cdk.Duration.hours(24),
    });

    // --- IAM role: allows DMS to write to Kinesis ---
    // DMS assumes this role when writing records to the Kinesis target endpoint.
    // Scoped to this stream only — not account-wide kinesis:* permissions.
    const dmsKinesisRole = new iam.Role(this, 'DmsKinesisRole', {
      assumedBy: new iam.ServicePrincipal('dms.amazonaws.com'),
      description: 'Allows DMS to write CDC events to Kinesis',
    });
    this.stream.grantWrite(dmsKinesisRole);
    // DescribeStream and ListShards are needed for DMS to verify the stream before starting the task.
    dmsKinesisRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['kinesis:DescribeStream', 'kinesis:ListShards'],
        resources: [this.stream.streamArn],
      }),
    );

    // --- DMS Security Group ---
    // DMS replication instance SG: must reach the RDS instance on 5432.
    const dmsSG = new ec2.SecurityGroup(this, 'DmsSG', {
      vpc: props.vpc,
      description: 'DMS replication instance security group',
      allowAllOutbound: true, // DMS also needs outbound to Kinesis (HTTPS) — allow all for simplicity
    });

    // Open RDS SG to DMS SG ingress. Using L1 to keep the SG rule in this stack's lifecycle,
    // not the RDS stack's. The rdsSG prop is passed read-only; only this stack mutates ingress.
    new ec2.CfnSecurityGroupIngress(this, 'DmsToDb', {
      groupId: props.rdsSG.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      sourceSecurityGroupId: dmsSG.securityGroupId,
      description: 'PostgreSQL from DMS replication instance',
    });

    // --- DMS Replication Subnet Group ---
    // DMS requires a subnet group that spans at least 2 AZs.
    // We use isolated subnets (same tier as RDS) so DMS can reach RDS without a NAT gateway.
    const replicationSubnetGroup = new dms.CfnReplicationSubnetGroup(this, 'ReplicationSubnetGroup', {
      replicationSubnetGroupDescription: 'Subnets for RDS CDC streaming DMS replication instance',
      subnetIds: props.vpc.isolatedSubnets.map((s) => s.subnetId),
    });

    // --- DMS Replication Instance ---
    // Provisioned (not Serverless) because:
    // - CDC is sustained/always-on; serverless DCU pricing (~$0.115/DCU-hr) exceeds provisioned cost
    // - Provisioned supports custom CDC start point (needed for recovery after task failure)
    // - Direct control over memory and disk to avoid swap-induced lag accumulation
    //
    // dms.t3.micro: cheapest instance, sufficient for low-TPS demo workloads.
    // 50 GB storage: DMS uses disk for task logs and cached (swapped) CDC events.
    //   Monitor FreeStorageSpace; alert below 5 GB to avoid storage-full failures.
    // !! Scale to r5.large or larger for high-TPS production workloads.
    const replicationInstance = new dms.CfnReplicationInstance(this, 'ReplicationInstance', {
      replicationInstanceClass: 'dms.t3.micro',
      allocatedStorage: 50,
      replicationSubnetGroupIdentifier: replicationSubnetGroup.ref,
      vpcSecurityGroupIds: [dmsSG.securityGroupId],
      publiclyAccessible: false,
      multiAz: false,
      // !! Set multiAz: true in production for HA (doubles instance cost)
    });

    // --- DMS Source Endpoint: RDS PostgreSQL ---
    //
    // extraConnectionAttributes (semicolon-separated key=value pairs):
    //   heartbeatEnable=true       — sends a heartbeat transaction every heartbeatFrequency minutes.
    //                                Advances the replication slot LSN during idle periods, preventing
    //                                WAL accumulation from writes to non-replicated tables.
    //   heartbeatFrequency=5       — heartbeat every 5 minutes (default).
    //   heartbeatSchema=public     — schema where heartbeat artifacts are written; DMS user needs
    //                                write access to this schema.
    //   slotName=dms_cdc_slot      — explicit slot name; makes it identifiable in pg_replication_slots
    //                                for monitoring and cleanup. Without this, DMS auto-generates names,
    //                                making orphaned slot detection harder.
    //   pluginName=pglogical       — logical decoding plugin. Provides richer change metadata than
    //                                test_decoding. Must be available on the RDS instance (it is, by default).
    const sourceEndpoint = new dms.CfnEndpoint(this, 'SourceEndpoint', {
      endpointType: 'source',
      engineName: 'postgres',
      serverName: props.rdsInstance.dbInstanceEndpointAddress,
      port: 5432,
      databaseName: 'demo',
      // DMS reads credentials from the secret at task creation time — not at synth time.
      // IAM DB auth is not supported for CDC on RDS PostgreSQL.
      username: props.rdsSecret.secretValueFromJson('username').unsafeUnwrap(),
      password: props.rdsSecret.secretValueFromJson('password').unsafeUnwrap(),
      extraConnectionAttributes: [
        'heartbeatEnable=true',
        'heartbeatFrequency=5',
        'heartbeatSchema=public',
        'slotName=dms_cdc_slot',
        'pluginName=pglogical',
      ].join(';'),
    });

    // --- DMS Target Endpoint: Kinesis ---
    //
    // includeTransactionDetails: true — adds transaction_id to every record.
    //   Used as part of the idempotency key in the Lambda handler (schema.table.pk.op.txn_id).
    //
    // partitionIncludeSchemaTable: true — prefixes the partition key with schema.table name.
    //   Prevents hot shards when the primary key has low cardinality across multiple tables.
    //   For a single-table demo this is not strictly needed, but it's the correct default.
    //
    // messageFormat: 'json' — human-readable; 'json-unformatted' saves bytes but harder to debug.
    const targetEndpoint = new dms.CfnEndpoint(this, 'TargetEndpoint', {
      endpointType: 'target',
      engineName: 'kinesis',
      kinesisSettings: {
        streamArn: this.stream.streamArn,
        serviceAccessRoleArn: dmsKinesisRole.roleArn,
        messageFormat: 'json',
        includeTransactionDetails: true,
        includePartitionValue: true,
        partitionIncludeSchemaTable: true,
      },
    });

    // --- DMS Replication Task ---
    //
    // migrationType: 'full-load-and-cdc' — first snapshots existing rows (full load), then
    //   switches to streaming CDC from the point the snapshot started. This ensures the Lambda
    //   consumer sees ALL rows, not just changes after DMS was started.
    //   Alternative: 'cdc' only — use when the target already has the initial data.
    //
    // tableMappings: selects public.quotes only. The 'include-all' rule-action with the schema
    //   and table filters tells DMS which tables to replicate.
    //
    // replicationTaskSettings: JSON blob controlling error handling and logging.
    //   RecoverableErrorCount: -1 — DMS retries recoverable errors (network blips, throttling)
    //     indefinitely rather than failing the task. Correct for long-running CDC.
    //   DataErrorPolicy: LOG_ERROR — on a data conversion error, log and continue (don't stop).
    //     Consider STOP_TASK in production if dropped events should be surfaced immediately.
    const tableMappings = {
      rules: [
        {
          'rule-type': 'selection',
          'rule-id': '1',
          'rule-name': 'include-quotes',
          'object-locator': {
            'schema-name': 'public',
            'table-name': 'quotes',
          },
          'rule-action': 'include',
        },
      ],
    };

    const taskSettings = {
      TargetMetadata: {
        TargetSchema: '',
        SupportLobs: true,
        FullLobMode: false,
        LobChunkSize: 64,
        LimitedSizeLobMode: true,
        LobMaxSize: 32,
      },
      FullLoadSettings: {
        TargetTablePrepMode: 'DO_NOTHING',
      },
      Logging: {
        EnableLogging: true,
        LogComponents: [
          { Id: 'SOURCE_UNLOAD', Severity: 'LOGGER_SEVERITY_DEFAULT' },
          { Id: 'TARGET_LOAD', Severity: 'LOGGER_SEVERITY_DEFAULT' },
          { Id: 'TASK_MANAGER', Severity: 'LOGGER_SEVERITY_DEFAULT' },
        ],
      },
      ControlTablesSettings: {
        historyTimeslotInMinutes: 5,
        StatusTableEnabled: true,
        SuspendedTablesTableEnabled: true,
      },
      ErrorBehavior: {
        DataErrorPolicy: 'LOG_ERROR',
        DataErrorEscalationPolicy: 'SUSPEND_TABLE',
        DataErrorEscalationCount: 50,
        TableErrorPolicy: 'SUSPEND_TABLE',
        TableErrorEscalationPolicy: 'STOP_TASK',
        TableErrorEscalationCount: 50,
        RecoverableErrorCount: -1,
        RecoverableErrorInterval: 5,
        RecoverableErrorThrottling: true,
        RecoverableErrorThrottlingMax: 1800,
        ApplyErrorDeletePolicy: 'IGNORE_RECORD',
        ApplyErrorInsertPolicy: 'LOG_ERROR',
        ApplyErrorUpdatePolicy: 'LOG_ERROR',
        ApplyErrorEscalationPolicy: 'LOG_ERROR',
        ApplyErrorEscalationCount: 0,
      },
    };

    const replicationTask = new dms.CfnReplicationTask(this, 'ReplicationTask', {
      migrationType: 'full-load-and-cdc',
      replicationInstanceArn: replicationInstance.ref,
      sourceEndpointArn: sourceEndpoint.ref,
      targetEndpointArn: targetEndpoint.ref,
      tableMappings: JSON.stringify(tableMappings),
      replicationTaskSettings: JSON.stringify(taskSettings),
    });

    // --- Outputs ---
    new cdk.CfnOutput(this, 'KinesisStreamName', { value: this.stream.streamName });
    new cdk.CfnOutput(this, 'KinesisStreamArn', { value: this.stream.streamArn });
    new cdk.CfnOutput(this, 'DmsTaskArn', { value: replicationTask.ref });
    new cdk.CfnOutput(this, 'ReplicationInstanceArn', { value: replicationInstance.ref });
  }
}

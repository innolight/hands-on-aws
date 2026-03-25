import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as kms from 'aws-cdk-lib/aws-kms';
import { globalClusterIdentifier } from './stack_primary';

export const rdsAuroraGlobalSecondaryStackName = 'RdsAuroraGlobalSecondary';

interface RdsAuroraGlobalSecondaryStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  bastionSG: ec2.SecurityGroup;
}

// Aurora Global secondary cluster in eu-west-1.
// Receives storage-level replication from the primary cluster (<1s lag).
// Read-only by default — write forwarding disabled (see comments on CfnDBCluster).
//
// Why all L1 constructs?
// CDK's L2 DatabaseCluster always generates masterUsername + masterUserPassword.
// Secondary clusters must NOT set these — they are inherited from the primary.
// Specifying them causes CloudFormation to reject the request. Until this is fixed
// upstream (https://github.com/aws/aws-cdk/issues/29880), use CfnDBCluster directly.
export class RdsAuroraGlobalSecondaryStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RdsAuroraGlobalSecondaryStackProps) {
    super(scope, id, props);

    const dbSG = new ec2.SecurityGroup(this, 'DbSG', {
      vpc: props.vpc,
      description: 'Aurora Global Database secondary cluster security group',
      allowAllOutbound: false,
    });

    new ec2.CfnSecurityGroupIngress(this, 'BastionToDb', {
      groupId: dbSG.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      sourceSecurityGroupId: props.bastionSG.securityGroupId,
      description: 'PostgreSQL from bastion (SSM tunnel)',
    });

    // Cross-region encrypted replicas require an explicit KMS key in the secondary region.
    // The primary's KMS key is regional (eu-central-1) and cannot be used here directly.
    const encryptionKey = new kms.Key(this, 'EncryptionKey', {
      description: 'Aurora Global Database secondary cluster encryption key',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const subnetGroup = new rds.CfnDBSubnetGroup(this, 'SubnetGroup', {
      dbSubnetGroupDescription: 'Aurora Global secondary cluster subnet group',
      subnetIds: props.vpc.isolatedSubnets.map((s) => s.subnetId),
    });

    // Parameter groups are regional resources — even though the secondary inherits
    // data from the primary, it needs its own parameter group in eu-west-1.
    const parameterGroup = new rds.CfnDBClusterParameterGroup(this, 'ParamGroup', {
      family: 'aurora-postgresql17',
      description: 'Aurora Global Database secondary cluster parameter group',
      parameters: secondaryClusterParameters,
    });

    const cluster = new rds.CfnDBCluster(this, 'Cluster', {
      // Joins this cluster to the global cluster. Aurora provisions the cluster as a
      // read-only replica of the primary, replicating at the storage layer.
      globalClusterIdentifier,

      engine: 'aurora-postgresql',
      // Must match the primary's engine version exactly (major + minor).
      // Major version upgrades require removing secondary clusters first.
      engineVersion: '17.7',

      dbSubnetGroupName: subnetGroup.ref,
      vpcSecurityGroupIds: [dbSG.securityGroupId],
      dbClusterParameterGroupName: parameterGroup.ref,

      enableCloudwatchLogsExports: ['postgresql'],

      // Write forwarding lets this secondary cluster accept DML (INSERT/UPDATE/DELETE)
      // and forward it to the primary over the replication channel.
      //
      // Consistency modes (set via apg_write_forward.consistency_mode parameter):
      //   SESSION (default) — reads in the same session see their own forwarded writes
      //   EVENTUAL           — no consistency wait; lowest latency; reads may be stale
      //   GLOBAL             — waits until secondary catches up to primary commit point;
      //                        highest latency but strongest consistency
      //
      // Latency: forwarded writes add ~44% overhead vs direct writes (cross-region
      // round-trip to eu-central-1). Best for light, infrequent writes from eu-west-1.
      //
      // Limitations:
      //   - No DDL (CREATE / ALTER / DROP)
      //   - No SERIALIZABLE isolation (only READ COMMITTED and REPEATABLE READ)
      //   - No stored procedures or UDFs
      //   - No TRUNCATE, VACUUM, LOCK TABLE, SAVEPOINT
      //   - Connects via the secondary's reader endpoint (not writer endpoint)
      //   - Reserved connections: apg_write_forward.max_forwarding_connections_percent
      //     (default 25%) limits primary connections available for forwarded writes
      //
      // To enable: set enableGlobalWriteForwarding: true and re-deploy.
      enableGlobalWriteForwarding: false,

      // kmsKeyId must be set explicitly for cross-region encrypted replicas —
      // KMS keys are regional, so the primary's key (eu-central-1) cannot be used here.
      // storageEncrypted is inherited from the primary; do not set it on the secondary.
      kmsKeyId: encryptionKey.keyArn,

      // DO NOT set masterUsername, masterUserPassword, or databaseName.
      // These are inherited from the primary cluster. CloudFormation will reject the
      // request if you specify them on a secondary cluster.

      deletionProtection: false,
    });

    // Single instance in the secondary cluster. Aurora routes all reads to this instance.
    // Add more instances for read scaling: create additional CfnDBInstance resources
    // pointing to the same dbClusterIdentifier.
    new rds.CfnDBInstance(this, 'Instance1', {
      dbClusterIdentifier: cluster.ref,
      dbInstanceClass: 'db.r6g.large', // smallest class supported by Aurora Global Databases
      engine: 'aurora-postgresql',
      dbInstanceIdentifier: 'aurora-global-secondary-1',
      // Performance Insights: query-level diagnostics in the CloudWatch console.
      enablePerformanceInsights: true,
      performanceInsightsRetentionPeriod: 7, // 7 days, free tier
      publiclyAccessible: false,
    });

    // Secondary writer endpoint — the cluster's primary instance in this region.
    // Without write forwarding, this endpoint accepts reads only.
    new cdk.CfnOutput(this, 'WriterEndpoint', { value: cluster.attrEndpointAddress });
    // Reader endpoint — load-balanced across all instances in this cluster.
    // Use this for read traffic from eu-west-1 applications.
    new cdk.CfnOutput(this, 'ReaderEndpoint', { value: cluster.attrReadEndpointAddress });
    new cdk.CfnOutput(this, 'DbPort', { value: cluster.attrEndpointPort });
  }
}

// Parameter groups are regional — each cluster needs its own in its region.
// These settings mirror the primary cluster's parameter group.
const secondaryClusterParameters = {
  log_min_duration_statement: '1000',
  log_statement: 'ddl',
  log_connections: '1',
  log_disconnections: '1',
  log_lock_waits: '1',
  log_temp_files: '0',
  log_autovacuum_min_duration: '250',
  idle_in_transaction_session_timeout: '300000',
  statement_timeout: '60000',
  random_page_cost: '1.1',
  shared_preload_libraries: 'pg_stat_statements,auto_explain',
  'pg_stat_statements.track': 'top',
  'auto_explain.log_min_duration': '5000',
};

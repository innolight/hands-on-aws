import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as logs from 'aws-cdk-lib/aws-logs';

export const rdsAuroraProvisionedStackName = 'RdsAuroraProvisioned';

interface RdsAuroraProvisionedStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  bastionSG: ec2.SecurityGroup;
}

// Demo Server → SSM tunnel → Bastion → Aurora Writer (shared storage layer) ↔ Aurora Reader
// Writer endpoint: single DNS name always pointing to current primary instance.
// Reader endpoint: load-balances across all reader instances.
// Custom endpoints: static member groups for workload-specific routing (OLTP vs analytics).
export class RdsAuroraProvisionedStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RdsAuroraProvisionedStackProps) {
    super(scope, id, props);

    const dbSG = new ec2.SecurityGroup(this, 'DbSG', {
      vpc: props.vpc,
      description: 'Aurora provisioned cluster security group',
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

    const engine = rds.DatabaseClusterEngine.auroraPostgres({
      version: rds.AuroraPostgresEngineVersion.VER_17_7,
    });

    // Explicit, tuned parameter group — aurora-postgresql17 family is derived from the engine.
    const parameterGroup = new rds.ParameterGroup(this, 'ParamGroup', {
      engine,
      parameters: clusterParameters,
    });

    const cluster = new rds.DatabaseCluster(this, 'Cluster', {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSG],
      engine,
      // Writer in the default AZ (tier 0 = highest failover priority).
      writer: rds.ClusterInstance.provisioned('Writer', {
        instanceIdentifier: 'aurora-provisioned-writer',
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM),
        // Tier 0 = first promoted on failover. Only one instance should be tier 0.
        promotionTier: 0,
      }),
      readers: [
        // Explicit instanceIdentifier so custom endpoint StaticMembers can reference it.
        rds.ClusterInstance.provisioned('Reader1', {
          instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM),
          promotionTier: 1,
          instanceIdentifier: 'aurora-provisioned-reader1',
        }),
      ],
      credentials: rds.Credentials.fromGeneratedSecret('postgres'),
      defaultDatabaseName: 'demo',
      parameterGroup,
      // AURORA = standard storage. Switch to AURORA_IOPT1 when I/O charges exceed
      // ~25% of total Aurora spend — at that crossover, flat-rate I/O Optimized
      // ($0.225/GB-month) is cheaper than per-I/O billing ($0.20/million requests).
      storageType: rds.DBClusterStorageType.AURORA,
      storageEncrypted: true,

      // Cost of CloudWatch log: Ingestion = $0.50/GB, Storage = $0.03/GB/month
      // CloudWatch log enables persistent, searchable logs
      // Without CloudWatch export, logs are written to the local instance storage (the Aurora instance's OS disk).
      // Cost: $0, Retention: ~1–3 days, controlled by Aurora's internal log rotation (not configurable).
      cloudwatchLogsExports: ['postgresql'],
      cloudwatchLogsRetention: logs.RetentionDays.ONE_DAY, // Adjust in production

      enablePerformanceInsights: true,
      // DEFAULT = 7 days, included free. Paid tiers: 1 month ($0.02/vCPU/hr) or 2 years.
      performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT,
      // Enhanced monitoring: 60s granularity, billed per instance.
      monitoringInterval: cdk.Duration.seconds(60),

      // ROLLING updates restart instances one at a time — zero downtime during parameter
      // group or minor version changes. BULK is faster but takes all instances offline.
      // It is implemented as DependsOn chains in CloudFormation.
      // Default is BULK which might causes downtime during updates.
      instanceUpdateBehaviour: rds.InstanceUpdateBehaviour.ROLLING,

      // !! Change the following in production.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
    });

    // Custom endpoints allow routing queries to a specific subset of instances.
    // Both point to the same reader here. In production, add dedicated reader
    // instances per workload class (e.g. r6g.large for OLTP, r6g.2xlarge for analytics).
    // CfnDBClusterEndpoint is not exported in aws-cdk-lib v2.240 — use CfnResource.
    new cdk.CfnResource(this, 'OltpEndpoint', {
      type: 'AWS::RDS::DBClusterEndpoint',
      properties: {
        DBClusterIdentifier: cluster.clusterIdentifier,
        EndpointType: 'READER',
        StaticMembers: ['aurora-prov-reader1'],
      },
    });

    const analyticsEndpoint = new cdk.CfnResource(this, 'AnalyticsEndpoint', {
      type: 'AWS::RDS::DBClusterEndpoint',
      properties: {
        DBClusterIdentifier: cluster.clusterIdentifier,
        EndpointType: 'READER',
        StaticMembers: ['aurora-prov-reader1'],
      },
    });

    new cdk.CfnOutput(this, 'WriterEndpoint', { value: cluster.clusterEndpoint.hostname });
    new cdk.CfnOutput(this, 'ReaderEndpoint', { value: cluster.clusterReadEndpoint.hostname });
    new cdk.CfnOutput(this, 'OltpReaderEndpoint', { value: analyticsEndpoint.getAtt('Endpoint').toString() });
    new cdk.CfnOutput(this, 'AnalyticsReaderEndpoint', { value: analyticsEndpoint.getAtt('Endpoint').toString() });
    new cdk.CfnOutput(this, 'DbPort', { value: cluster.clusterEndpoint.port.toString() });
    new cdk.CfnOutput(this, 'SecretArn', { value: cluster.secret!.secretArn });
    new cdk.CfnOutput(this, 'DatabaseName', { value: 'demo' });
  }
}

// Doucmentation on the default setting for cluster-level parameters
// https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraPostgreSQL.Reference.ParameterGroups.html
const clusterParameters = {
  // -- Logging --
  log_min_duration_statement: '1000',
  log_statement: 'ddl',
  log_connections: '1',
  log_disconnections: '1',
  log_lock_waits: '1', // Logs long lock waits.
  log_temp_files: '0', // Logs all temporary file usage. Considering >10MB to catch only large temp files.
  log_autovacuum_min_duration: '250',

  // -- Timeouts --
  // Kill idle-in-transaction sessions after 5 min. Idle-in-transaction sessions
  // hold row locks and block autovacuum. !! Lower to 30–60s in production.
  // Default of 24h is too high.
  idle_in_transaction_session_timeout: '300000',
  // Kill queries running longer than 60s. Set per-role in production.
  // Default is 0 (disabled) which allows runaway queries to run indefinitely.
  statement_timeout: '60000',
  // lock_timeout is not a cluster parameter group parameter — set it per role/database:
  // ALTER ROLE postgres SET lock_timeout = '10s';

  // -- Aurora-specific --
  // random_page_cost=1.1: Aurora uses shared SSD storage with near-uniform access
  // latency; the default 4.0 (tuned for spinning disk seek cost) causes the planner
  // to under-use indexes. 1.1 reflects actual Aurora I/O cost.
  // well-accepted community guidance for Aurora/SSD, not an AWS official recommendation
  random_page_cost: '1.1',
  // shared_preload_libraries: pg_stat_statements for query-level stats,
  // auto_explain to log slow query plans without manual EXPLAIN.
  shared_preload_libraries: 'pg_stat_statements,auto_explain',
  'pg_stat_statements.track': 'top', // default is 'top' tracking only top-levels statement
  // Log query plans for statements taking longer than 5s (auto_explain).
  'auto_explain.log_min_duration': '5000',

  // -- Autovacuum --
  // Autovacuum scale factors: default 10% triggers too late on large tables.
  // 5%/2% runs vacuum more frequently, preventing table bloat.
  autovacuum_vacuum_scale_factor: '0.05', // default 0.1
  autovacuum_analyze_scale_factor: '0.02', // default 0.05
  // Allow up to 5 parallel autovacuum workers — more aggressive cleanup for
  // write-heavy workloads with many tables accumulating dead rows.
  // Default is GREATEST(Ram in Gb / 60, 3) or 3 when RAM <= 180GB
  autovacuum_max_workers: '5',
};

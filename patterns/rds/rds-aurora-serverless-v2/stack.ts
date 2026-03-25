import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as logs from 'aws-cdk-lib/aws-logs';

export const rdsAuroraServerlessV2StackName = 'RdsAuroraServerlessV2';

interface RdsAuroraServerlessV2StackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  bastionSG: ec2.SecurityGroup;
}

// Demo Server → SSM tunnel → Bastion → Aurora Writer (shared storage layer) ↔ Aurora Reader
// Both writer and reader are Serverless v2 instances: they scale in 0.5 ACU increments
// from 0 (auto-paused) to 16 ACU, with no manual instance type selection.
export class RdsAuroraServerlessV2Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RdsAuroraServerlessV2StackProps) {
    super(scope, id, props);

    const dbSG = new ec2.SecurityGroup(this, 'DbSG', {
      vpc: props.vpc,
      description: 'Aurora Serverless v2 cluster security group',
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

    // Aurora PostgreSQL 17.7 declares serverlessV2AutoPauseSupported in its engine
    // feature flags, which allows setting serverlessV2MinCapacity to 0 (auto-pause).
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

      // -- Serverless v2 capacity --
      // Scaling is continuous and non-disruptive (works mid-transaction). The engine
      // measures load every second and adjusts in 0.5 ACU steps.
      // 1 ACU ≈ 2 GiB RAM + proportional CPU.
      //
      // minCapacity 0: enables auto-pause — the cluster shuts down compute after
      // 5 minutes of idle, resuming in ~15s on the next connection (30s+ after
      // extended sleep). Suitable for dev/test where idle hours dominate cost.
      // !! Production: set minCapacity ≥ 2 (required for Performance Insights) and
      //    disable auto-pause by removing serverlessV2AutoPauseDuration.
      serverlessV2MinCapacity: 0,
      serverlessV2MaxCapacity: 16,
      // Pause compute after 5 minutes of idle (minimum allowed, range 5-1440 min).
      serverlessV2AutoPauseDuration: cdk.Duration.seconds(300),

      // All-serverless cluster: both writer and reader use Serverless v2.
      // Alternative: provisioned writer + serverless readers — a common production
      // pattern when you want stable write latency and elastic read scaling.
      // Alternative: enableLocalWriteForwarding — lets readers forward writes to
      // the writer, simplifying connection routing at the cost of higher write latency.
      writer: rds.ClusterInstance.serverlessV2('Writer', {
        instanceIdentifier: 'aurora-serverless-v2-writer',
      }),
      readers: [
        // scaleWithWriter: true → this reader is placed in promotion tier 0-1.
        // It always scales up to match the writer's ACU before the writer reaches
        // its target — ensuring the failover target never lags behind under load.
        // Tier 2+ readers (scaleWithWriter: false) scale independently based on
        // their own read load and are suited for read-only scaling beyond HA.
        rds.ClusterInstance.serverlessV2('Reader1', {
          instanceIdentifier: 'aurora-serverless-v2-reader1',
          // This reader will scale to match the writer instance to be failover-ready, improving High Availability (HA).
          // In Cloudformation, the instance is configured with PromotionTier: 1
          // Promotion Tier 0 or 1 will scale its capacity to match the writer instance.
          scaleWithWriter: true,
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

      cloudwatchLogsExports: ['postgresql'],
      cloudwatchLogsRetention: logs.RetentionDays.ONE_DAY, // Adjust in production

      // Performance Insights requires ≥ 2 ACU. When the cluster is paused or below
      // 2 ACU, PI silently stops collecting — no error, no extra cost.
      enablePerformanceInsights: true,
      // DEFAULT = 7 days, included free. Paid tiers: 1 month ($0.02/vCPU/hr) or 2 years.
      performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT,
      monitoringInterval: undefined, // turn off enhanced monitoring

      // ROLLING updates restart instances one at a time — zero downtime during parameter
      // group or minor version changes. BULK is faster but takes all instances offline.
      instanceUpdateBehaviour: rds.InstanceUpdateBehaviour.ROLLING,

      // !! Change the following in production.
      // Backup retention defaults to 1 day. Set to Duration.days(7-35) in production.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
    });

    new cdk.CfnOutput(this, 'WriterEndpoint', { value: cluster.clusterEndpoint.hostname });
    new cdk.CfnOutput(this, 'ReaderEndpoint', { value: cluster.clusterReadEndpoint.hostname });
    new cdk.CfnOutput(this, 'DbPort', { value: cluster.clusterEndpoint.port.toString() });
    new cdk.CfnOutput(this, 'SecretArn', { value: cluster.secret!.secretArn });
    new cdk.CfnOutput(this, 'DatabaseName', { value: 'demo' });
  }
}

// Documentation on the default setting for cluster-level parameters:
// https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraPostgreSQL.Reference.ParameterGroups.html
const clusterParameters = {
  // -- Logging --
  log_min_duration_statement: '1000',
  log_statement: 'ddl',
  log_connections: '1',
  log_disconnections: '1',
  log_lock_waits: '1',
  log_temp_files: '0',
  log_autovacuum_min_duration: '250',

  // -- Timeouts --
  // Kill idle-in-transaction sessions after 5 min. Idle-in-transaction sessions
  // hold row locks and block autovacuum. !! Lower to 30–60s in production.
  idle_in_transaction_session_timeout: '300000',
  // Kill queries running longer than 60s. Set per-role in production.
  statement_timeout: '60000',

  // -- Aurora-specific --
  // random_page_cost=1.1: Aurora uses shared SSD storage with near-uniform access
  // latency; the default 4.0 (tuned for spinning disk seek cost) causes the planner
  // to under-use indexes. 1.1 reflects actual Aurora I/O cost.
  random_page_cost: '1.1',
  // pg_stat_statements: query-level stats. auto_explain: log slow query plans.
  shared_preload_libraries: 'pg_stat_statements,auto_explain',
  'pg_stat_statements.track': 'top',
  'auto_explain.log_min_duration': '5000',

  // -- Autovacuum --
  // Scale factors: default 10% triggers too late on large tables.
  // 5%/2% runs vacuum more frequently, preventing table bloat.
  autovacuum_vacuum_scale_factor: '0.05',
  autovacuum_analyze_scale_factor: '0.02',
  // 3 workers: conservative for low-ACU instances where RAM is limited.
  // At min 0.5 ACU (1 GiB), 5 workers would consume too much memory.
  // Note: autovacuum does not run while the cluster is auto-paused — table bloat
  // accumulates during long idle periods and all cleanup runs on resume.
  // !! Increase to 5+ in production when min ACU ≥ 4.
  autovacuum_max_workers: '3',
};

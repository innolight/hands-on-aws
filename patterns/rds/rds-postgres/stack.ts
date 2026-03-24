import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';

export const rdsPostgresStackName = 'RdsPostgres';

interface RdsPostgresStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  bastionSG: ec2.SecurityGroup;
}

// client -> SSM port forward -> EC2 bastion -> RDS PostgreSQL (isolated subnet)
//        -> RDS Proxy -> RDS PostgreSQL (optional; reduces failover time and connection churn)
export class RdsPostgresStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RdsPostgresStackProps) {
    super(scope, id, props);

    // context: -c multiAz=true deploys a synchronous standby in a second AZ.
    // Failover is automatic (DNS CNAME flip) in 60–120s. The standby is invisible —
    // it accepts no connections and provides zero read scaling. You pay 2× for HA only.
    const multiAz = this.node.tryGetContext('multiAz') === 'true';

    // DB accepts connections from the bastion only (via SSM port forward).
    const dbSG = new ec2.SecurityGroup(this, 'DbSG', {
      vpc: props.vpc,
      description: 'RDS PostgreSQL security group',
      allowAllOutbound: false,
    });

    // L1 ingress rule keeps SG ownership inside this stack (avoids cross-stack mutation).
    new ec2.CfnSecurityGroupIngress(this, 'BastionToDb', {
      groupId: dbSG.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      sourceSecurityGroupId: props.bastionSG.securityGroupId,
      description: 'PostgreSQL from bastion (SSM tunnel)',
    });

    const engine = rds.DatabaseInstanceEngine.postgres({
      version: rds.PostgresEngineVersion.VER_17_7,
    });

    const instance = new rds.DatabaseInstance(this, 'Instance', {
      instanceIdentifier: 'rds-postgres-classic-instance',
      databaseName: 'demo',
      // PostgreSQL 17 — minor upgrades (17.x) include security patches and are applied during
      // the maintenance window when autoMinorVersionUpgrade is on. Plan major upgrades (17 → 18)
      // carefully — they require backward-compat testing. RDS does not support downgrading.
      engine,
      // t4g.micro: smallest Graviton instance (~$13/mo). Graviton (t4g/m7g) is ~10% cheaper than
      // equivalent x86 (t3/m6i) at the same tier. Scale up to t4g.small/m7g.large when CPU or
      // memory is a bottleneck. Keep micro for dev/test.
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc: props.vpc,
      // Isolated subnets have no internet route — DB never needs outbound access.
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSG],
      multiAz,
      // fromGeneratedSecret creates a Secrets Manager secret with username + auto-generated password.
      // Access credentials via instance.secret at deploy time or SecretArn output at runtime.
      credentials: rds.Credentials.fromGeneratedSecret('postgres'),
      // 20 GiB is the RDS minimum. Raise if your dataset exceeds 20 GiB; maxAllocatedStorage
      // handles growth automatically so you don't need to over-provision upfront.
      allocatedStorage: 20,
      // GP3 gives 3000 IOPS and 125 MiBps baseline free, regardless of volume size (unlike GP2
      // which ties IOPS to size). Switch to IO2 only when you need >16,000 IOPS or sub-ms latency.
      storageType: rds.StorageType.GP3,
      // maxAllocatedStorage enables autoscaling — RDS grows the volume when free space drops
      // below 10%. Set equal to allocatedStorage to disable autoscaling. Raise the cap for large
      // datasets; keeping it too low causes IO stalls when the volume can't grow in time.
      maxAllocatedStorage: 100,
      // backupRetention=1: minimum automated backup window. Increase to 7–35 days in production
      // for point-in-time restore. Never set to 0 — that disables automated backups entirely and
      // blocks read replica creation.
      backupRetention: cdk.Duration.days(1),

      // Enable encrypt data at rest
      storageEncrypted: true,

      // RDS default is enabled; minor upgrades ship security patches during the maintenance window.
      // Disable only if your app is sensitive to minor-version behaviour changes (rare).
      autoMinorVersionUpgrade: true,

      // Enables Enhanced Monitoring (OS-level metrics) beyond Standard RDS metrics.
      //   + CPU: Total utilization % => Per-process CPU, user/system/idle/wait breakdown
      //   + Memory: Freeable memory only => Total, free, cached, buffered, active, inactive
      //   + Disk: Read/write IOPS and throughput => Per-filesystem usage, read/write latency
      //   + Network: Total throughput => Per-interface throughput and packet metrics
      //   + Processes: No visibility => Top processes by CPU and memory
      // RDS Default is disabled. Enabling adds ~$1/mo to CloudWatch costs
      monitoringInterval: cdk.Duration.seconds(60),

      parameterGroup: new rds.ParameterGroup(this, 'ParameterGroup', {
        engine,
        description: 'Logging and timeout safety nets for RDS PostgreSQL 17',
        parameters: parameterGroupParameters,
      }),

      // Enable in Performance Insights to monitor database workload and wait events
      enablePerformanceInsights: true,
      databaseInsightsMode: rds.DatabaseInsightsMode.STANDARD,
      // 7 days free, up to 2 years with extra cost.
      // 'ADVANCED' databaseInsightsMode mode require 15 months retention.
      performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT,

      // !! Change the following in production: use SNAPSHOT/RETAIN to prevent data loss on stack
      // destroy; set deletionProtection=true to block accidental deletion (stack destroy will fail
      // until you disable it first). Keep DESTROY/false in dev so `cdk destroy` works cleanly.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
    });

    // RDS Proxy pools and multiplexes application connections to the DB.
    // Key benefits:
    //   1. Failover: proxy reconnects to the new primary automatically — app sees ~30s of
    //      retries vs 60–120s of hard failures when connecting directly.
    //   2. Connection limit: proxy holds up to maxConnectionsPercent% of max_connections.
    //      Lambda with 500 concurrent invocations opens 500 connections; the proxy
    //      multiplexes those to a fraction of max_connections on the DB instance.
    const proxy = instance.addProxy('Proxy', {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      secrets: [instance.secret!],
      securityGroups: [dbSG],
      // Enforce encryption for data in transit to proxy
      requireTLS: true,
      // SCRAM-SHA-256 is the default auth for PostgreSQL 14+. Use POSTGRES_MD5 only for
      // compatibility with very old client libraries.
      clientPasswordAuthType: rds.ClientPasswordAuthType.POSTGRES_SCRAM_SHA_256,

      // borrowTimeout: how long a client waits for a pooled connection before getting an error.
      // The default 120s is often too long. A lower value helps your application "fail fast" and
      // trigger retries rather than hanging during a traffic spike.
      // 30s is a safe default; reduce for latency-sensitive workloads.
      borrowTimeout: cdk.Duration.seconds(30),

      // Reserves 10-20% for direct admin access, maintenance tasks, and emergency psql sessions that bypass the proxy.
      // Max Connections managed by Proxy = maxConnectionsPercent * max_connections (a PostgreSQL config parameter that varies by instance size).
      // max_connections is ~112 / 1GiB RAM for PostgreSQL, so a t4g.micro with 1 GiB RAM has max_connections ≈ 100, and the proxy allows up to 90 connections with this setting.
      maxConnectionsPercent: 90,

      // Postgres processes are memory-heavy. Lowering this from the default (50%) aggressively
      // closes inactive backend connections, saving RAM on the DB instance.
      // Keep ≥ 10 — too low causes connection latency spikes on traffic bursts
      maxIdleConnectionsPercent: 10,

      // Connections idle for x minutes are returned to the pool and eventually closed.
      // Must be higher than your application's typical idle timeout to avoid unexpected connection drops
      idleClientTimeout: cdk.Duration.minutes(15),
    });

    new cdk.CfnOutput(this, 'DbEndpoint', { value: instance.dbInstanceEndpointAddress });
    new cdk.CfnOutput(this, 'DbPort', { value: instance.dbInstanceEndpointPort });
    new cdk.CfnOutput(this, 'ProxyEndpoint', { value: proxy.endpoint });
    new cdk.CfnOutput(this, 'SecretArn', { value: instance.secret!.secretArn });
    new cdk.CfnOutput(this, 'DatabaseName', { value: 'demo' });
    new cdk.CfnOutput(this, 'MultiAz', { value: String(multiAz) });
  }
}

const parameterGroupParameters = {
  // -- Logging: slow queries and connection lifecycle --

  // Single most useful knob for finding performance bottlenecks. Logs any query that
  // takes longer than 1s. Set to 0 temporarily to capture all queries; keep ≥1000 in
  // steady state to avoid log noise. Default: -1 (disabled).
  log_min_duration_statement: '1000',

  // Log DDL statements (CREATE/ALTER/DROP) for change auditing.
  // 'all' captures every query but generates excessive volume; 'ddl' is the right
  // steady-state level for schema change tracking. Default: none.
  log_statement: 'ddl',

  // Track connection open/close events with client IP and username.
  // Essential for diagnosing connection storms, leaks, and unexpected reconnects.
  // Default: off.
  log_connections: '1',
  log_disconnections: '1',

  // Log when a session waits longer than deadlock_timeout (default 1s) for a row lock.
  // Surfaces lock contention that would otherwise be invisible. Default: off.
  log_lock_waits: '1',

  // Log any query that spills a sort or hash operation to disk, with the file size.
  // A temp file means work_mem is too low for that query — increase work_mem or
  // rewrite the query. Value 0 = log all; a positive value is a minimum size in kB.
  // Default: -1 (disabled).
  log_temp_files: '0',

  // Log any autovacuum run that takes longer than 250ms. Helps spot tables with
  // excessive dead-row churn or tables that need per-table autovacuum tuning.
  // Default: -1 (disabled). Changed to 10000 in recent PG versions, still too high.
  log_autovacuum_min_duration: '250',

  // -- Timeouts: safety nets --

  // Kill any session sitting idle inside an open transaction for more than 5 minutes.
  // Common cause: app opens BEGIN but never COMMIT/ROLLBACK. Idle-in-transaction
  // sessions hold row locks and prevent autovacuum from cleaning dead tuples, causing
  // table bloat. !! Lower to 30–60s in production for latency-sensitive workloads.
  // Default: 0 (disabled).
  idle_in_transaction_session_timeout: '300000',

  // Kill any individual query running longer than 60s. Safety net against runaway
  // queries (e.g. accidental full table scan, or a query using a bad plan after a stats
  // refresh). Set per-role in production — shorter for web app roles (5–30s), 0 for
  // migration/ETL roles. Default: 0 (disabled).
  statement_timeout: '60000',
};

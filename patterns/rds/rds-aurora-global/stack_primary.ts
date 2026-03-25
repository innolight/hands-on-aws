import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as logs from 'aws-cdk-lib/aws-logs';

export const rdsAuroraGlobalPrimaryStackName = 'RdsAuroraGlobalPrimary';

// Shared identifier used by both the primary and secondary stacks.
// The secondary CfnDBCluster joins this global cluster by name — no cross-region
// CDK reference needed, just a string constant agreed on by both stacks.
export const globalClusterIdentifier = 'aurora-global-demo';

interface RdsAuroraGlobalPrimaryStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  bastionSG: ec2.SecurityGroup;
}

// Demo Server → SSM tunnel → Bastion (eu-central-1) → Aurora Global Primary Writer
//                                                      ↕ storage-level replication (<1s)
//                                               Aurora Global Secondary (us-east-1)
//
// One writer instance in the primary cluster. Reads and writes hit the writer.
// The secondary (stack_secondary.ts) serves read-only traffic from us-east-1.
export class RdsAuroraGlobalPrimaryStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RdsAuroraGlobalPrimaryStackProps) {
    super(scope, id, props);

    const dbSG = new ec2.SecurityGroup(this, 'DbSG', {
      vpc: props.vpc,
      description: 'Aurora Global Database primary cluster security group',
      allowAllOutbound: false,
    });

    // L1 ingress rule avoids mutating the bastionSG from this stack (cross-stack mutation
    // anti-pattern that creates implicit deploy-order dependencies).
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

    const parameterGroup = new rds.ParameterGroup(this, 'ParamGroup', {
      engine,
      parameters: clusterParameters,
    });

    const cluster = new rds.DatabaseCluster(this, 'Cluster', {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSG],
      engine,

      // Single writer, no readers in this pattern.
      // Add readers with ClusterInstance.provisioned('Reader1', { promotionTier: 1 })
      // for local read scaling — up to 15 readers per cluster.
      // In a global database, reads from other regions are served by the secondary
      // cluster (stack_secondary.ts), not by adding readers here.
      writer: rds.ClusterInstance.provisioned('Writer', {
        // Aurora Global Databases require memory-optimized instances (r-class).
        // Burstable (t-class) instances are not supported for global databases.
        // r6g.large is the smallest/cheapest supported option (~$0.28/hr).
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.R6G, ec2.InstanceSize.LARGE),
        promotionTier: 0,
        instanceIdentifier: 'aurora-global-writer',
        enablePerformanceInsights: true,
        performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT, // 7 days, free
      }),

      credentials: rds.Credentials.fromGeneratedSecret('postgres'),
      defaultDatabaseName: 'demo',
      parameterGroup,
      // AURORA = standard per-I/O billing. Switch to AURORA_IOPT1 when I/O costs
      // exceed ~25% of total spend (crossover at high write throughput).
      storageType: rds.DBClusterStorageType.AURORA,
      storageEncrypted: true,

      // ROLLING updates restart one instance at a time — zero downtime for minor
      // version updates and parameter group changes.
      instanceUpdateBehaviour: rds.InstanceUpdateBehaviour.ROLLING,

      // !! Change the following in production.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
    });

    // GlobalCluster wraps the primary Aurora cluster and manages cross-region
    // storage replication to secondary clusters (up to 5 regions).
    // Storage changes are replicated with typical lag < 1 second using Aurora's
    // distributed storage layer — not WAL-based replication like standard RDS.
    //
    // The GlobalCluster must be deleted AFTER all secondary clusters are removed.
    // Teardown order: RdsAuroraGlobalSecondary → RdsAuroraGlobalPrimary.
    new rds.CfnGlobalCluster(this, 'GlobalCluster', {
      globalClusterIdentifier,
      // Promote an existing cluster to be the global primary.
      // Aurora reads engine/version from the source cluster — do not specify them here.
      sourceDbClusterIdentifier: cluster.clusterArn,
      deletionProtection: false,
    });

    new cdk.CfnOutput(this, 'WriterEndpoint', { value: cluster.clusterEndpoint.hostname });
    new cdk.CfnOutput(this, 'DbPort', { value: cluster.clusterEndpoint.port.toString() });
    new cdk.CfnOutput(this, 'SecretArn', { value: cluster.secret!.secretArn });
    new cdk.CfnOutput(this, 'DatabaseName', { value: 'demo' });
    new cdk.CfnOutput(this, 'GlobalClusterIdentifier', { value: globalClusterIdentifier });
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
  shared_preload_libraries: 'pg_stat_statements,auto_explain',
  'auto_explain.log_min_duration': '5000',
};

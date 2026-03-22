import * as cdk from 'aws-cdk-lib';
import {Construct} from 'constructs';
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

    const instance = new rds.DatabaseInstance(this, 'Instance', {
      instanceIdentifier: 'rds-postgres-classic-instance',
      databaseName: 'demo',
      // PostgreSQL 17 — pick the latest minor via VER_17_x; major version upgrades are manual.
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_17_7,
      }),
      // t4g.micro: smallest Graviton instance (~$13/mo). Graviton is ~10% cheaper than
      // equivalent t3 at the same performance tier. Upgrade to t4g.small or m7g for production.
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc: props.vpc,
      // Isolated subnets have no internet route — DB never needs outbound access.
      vpcSubnets: {subnetType: ec2.SubnetType.PRIVATE_ISOLATED},
      securityGroups: [dbSG],
      multiAz,
      // fromGeneratedSecret creates a Secrets Manager secret with username + auto-generated password.
      // Access credentials via instance.secret at deploy time or SecretArn output at runtime.
      credentials: rds.Credentials.fromGeneratedSecret('postgres'),
      // 20 GiB is the minimum for GP3. GP3 gives 3000 IOPS and 125 MiBps baseline for free,
      // regardless of volume size — unlike GP2 which charges 3 IOPS/GiB (so 20 GiB = 60 IOPS).
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      // maxAllocatedStorage enables storage autoscaling — RDS grows the volume automatically
      // when free space drops below 10%. Omit only if you want strict storage cost control.
      maxAllocatedStorage: 100,
      // backupRetention=1 keeps 1 day of automated backups (minimum). Required for point-in-time
      // restore. Also required if you want to create read replicas from this instance.
      backupRetention: cdk.Duration.days(1),
      // !! Change the following in production.
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
      vpcSubnets: {subnetType: ec2.SubnetType.PRIVATE_ISOLATED},
      secrets: [instance.secret!],
      securityGroups: [dbSG],
      requireTLS: true,
      // SCRAM-SHA-256 is the default auth for PostgreSQL 14+. Use POSTGRES_MD5 only for
      // compatibility with very old client libraries.
      clientPasswordAuthType: rds.ClientPasswordAuthType.POSTGRES_SCRAM_SHA_256,
      // borrowTimeout: how long a client waits for a pooled connection before getting an error.
      // 30s is a safe default; reduce for latency-sensitive workloads.
      borrowTimeout: cdk.Duration.seconds(30),
      // Reserve 10% headroom so burst traffic doesn't exhaust the DB connection limit.
      maxConnectionsPercent: 90,
      // Connections idle for 10 minutes are returned to the pool and eventually closed.
      maxIdleConnectionsPercent: 50,
      idleClientTimeout: cdk.Duration.minutes(15),
    });

    new cdk.CfnOutput(this, 'DbEndpoint', {value: instance.dbInstanceEndpointAddress});
    new cdk.CfnOutput(this, 'DbPort', {value: instance.dbInstanceEndpointPort});
    new cdk.CfnOutput(this, 'ProxyEndpoint', {value: proxy.endpoint});
    new cdk.CfnOutput(this, 'SecretArn', {value: instance.secret!.secretArn});
    new cdk.CfnOutput(this, 'DatabaseName', {value: 'demo'});
    new cdk.CfnOutput(this, 'MultiAz', {value: String(multiAz)});
  }
}

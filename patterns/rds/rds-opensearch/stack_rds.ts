import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export const rdsOpensearchRdsStackName = 'RdsOpensearchRds';

interface RdsOpensearchRdsStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  bastionSG: ec2.SecurityGroup;
}

// RDS PostgreSQL source for OpenSearch Ingestion CDC.
// Logical replication must be enabled so OSI can read the WAL stream.
export class RdsOpensearchRdsStack extends cdk.Stack {
  public readonly instance: rds.DatabaseInstance;
  public readonly secret: secretsmanager.ISecret;
  public readonly dbSG: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: RdsOpensearchRdsStackProps) {
    super(scope, id, props);

    this.dbSG = new ec2.SecurityGroup(this, 'DbSG', {
      vpc: props.vpc,
      description: 'RDS OpenSearch source instance security group',
      allowAllOutbound: false,
    });

    // Bastion → DB ingress kept in this stack so it owns the SG rule lifecycle.
    // OSI pipeline → DB ingress is added in stack_pipeline.ts using CfnSecurityGroupIngress.
    new ec2.CfnSecurityGroupIngress(this, 'BastionToDb', {
      groupId: this.dbSG.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      sourceSecurityGroupId: props.bastionSG.securityGroupId,
      description: 'PostgreSQL from bastion (SSM tunnel)',
    });

    const engine = rds.DatabaseInstanceEngine.postgres({
      version: rds.PostgresEngineVersion.VER_17_7,
    });

    // rds.logical_replication=1 switches wal_level to 'logical', required by OSI's rds source plugin.
    // wal_sender_timeout=0: disables the WAL sender keepalive timeout. Without this, OSI connections
    //   drop during low-traffic windows, causing the replication slot LSN to stall and WAL to
    //   accumulate on disk. Monitor TransactionLogsDiskUsage — alert if it grows unboundedly.
    // max_wal_senders / max_replication_slots: headroom for the OSI slot plus monitoring connections.
    //   Each OSI pipeline occupies one slot; DMS or other consumers add more. Default (10) is ample
    //   for a single pipeline but raise if you add more consumers.
    const parameterGroup = new rds.ParameterGroup(this, 'ParameterGroup', {
      engine,
      parameters: {
        'rds.logical_replication': '1',
        wal_sender_timeout: '0',
        max_wal_senders: '10',
        max_replication_slots: '10',
      },
    });

    // t4g.micro: cheapest Graviton instance (~$13/mo). OSI reads the WAL from the replication
    // slot rather than issuing additional DB queries during CDC, so overhead at low write rates
    // is minimal. The snapshot export (initial full load) does issue a snapshot read — schedule
    // during a low-traffic window for large databases.
    // !! Scale up to t4g.small or larger for production workloads.
    this.instance = new rds.DatabaseInstance(this, 'Instance', {
      instanceIdentifier: 'rds-opensearch-source',
      databaseName: 'demo',
      engine,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.dbSG],
      multiAz: false,
      credentials: rds.Credentials.fromGeneratedSecret('postgres'),
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      // Backup retention must be ≥1 day to maintain the WAL needed for logical replication.
      // OSI holds a replication slot open; the slot prevents WAL recycling back to before
      // its LSN. Keep retention ≥7 days in production for point-in-time restore coverage.
      backupRetention: cdk.Duration.days(1),
      parameterGroup,

      // !! Change the following in production.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
    });

    this.secret = this.instance.secret!;

    new cdk.CfnOutput(this, 'DbEndpoint', { value: this.instance.dbInstanceEndpointAddress });
    new cdk.CfnOutput(this, 'DbPort', { value: this.instance.dbInstanceEndpointPort });
    new cdk.CfnOutput(this, 'SecretArn', { value: this.secret.secretArn });
    new cdk.CfnOutput(this, 'DatabaseName', { value: 'demo' });
  }
}

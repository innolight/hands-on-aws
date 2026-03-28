import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';

export const rdsRedshiftZeroEtlRdsStackName = 'RdsRedshiftZeroEtl-Rds';

interface RdsRedshiftZeroEtlRdsStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  bastionSG: ec2.SecurityGroup;
}

// Write rows to RDS → CfnIntegration streams WAL → Redshift Serverless (columnar storage)
export class RdsRedshiftZeroEtlRdsStack extends cdk.Stack {
  public readonly instance: rds.DatabaseInstance;

  constructor(scope: Construct, id: string, props: RdsRedshiftZeroEtlRdsStackProps) {
    super(scope, id, props);

    const dbSG = new ec2.SecurityGroup(this, 'DbSG', {
      vpc: props.vpc,
      description: 'RDS Zero-ETL source instance security group',
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

    const engine = rds.DatabaseInstanceEngine.postgres({
      version: rds.PostgresEngineVersion.VER_17_7,
    });

    // Zero-ETL requires these 6 parameters on the source instance.
    // rds.logical_replication=1 enables WAL-based CDC.
    // rds.replica_identity_full=1 writes all column values to WAL (not just PKs) — required
    //   for UPDATE/DELETE to replicate correctly, at the cost of higher WAL volume.
    // session_replication_role=origin prevents replication loops if you ever add triggers.
    // wal_sender_timeout=0 disables the timeout so long-running CDC connections don't drop.
    // max_wal_senders/max_replication_slots: one slot per integration; 20 leaves room to grow.
    const parameterGroup = new rds.ParameterGroup(this, 'ParameterGroup', {
      engine,
      parameters: {
        'rds.logical_replication': '1',
        'rds.replica_identity_full': '1',
        session_replication_role: 'origin',
        wal_sender_timeout: '0',
        max_wal_senders: '20',
        max_replication_slots: '20',
      },
    });

    // t4g.micro: cheapest Graviton instance (~$13/mo). Zero-ETL has no instance-type requirement
    // — the integration only reads WAL, which adds minimal overhead at low write rates.
    // !! Scale up to t4g.small or larger for production workloads.
    this.instance = new rds.DatabaseInstance(this, 'Instance', {
      instanceIdentifier: 'rds-zero-etl-source',
      databaseName: 'demo',
      engine,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSG],
      multiAz: false,
      credentials: rds.Credentials.fromGeneratedSecret('postgres'),
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      // Automated backups are required for Zero-ETL — the integration uses the backup
      // infrastructure to bootstrap the initial full snapshot before streaming changes.
      backupRetention: cdk.Duration.days(1),
      parameterGroup,

      // !! Change the following in production.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
    });

    new cdk.CfnOutput(this, 'DbEndpoint', { value: this.instance.dbInstanceEndpointAddress });
    new cdk.CfnOutput(this, 'DbPort', { value: this.instance.dbInstanceEndpointPort });
    new cdk.CfnOutput(this, 'SecretArn', { value: this.instance.secret!.secretArn });
    new cdk.CfnOutput(this, 'DatabaseName', { value: 'demo' });
  }
}

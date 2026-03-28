import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export const rdsCdcStreamingRdsStackName = 'RdsCdcStreamingRds';

interface RdsCdcStreamingRdsStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  bastionSG: ec2.SecurityGroup;
}

// Insert rows into RDS → DMS reads WAL via logical replication → Kinesis Data Streams → Lambda
export class RdsCdcStreamingRdsStack extends cdk.Stack {
  public readonly instance: rds.DatabaseInstance;
  public readonly secret: secretsmanager.ISecret;
  public readonly dbSG: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: RdsCdcStreamingRdsStackProps) {
    super(scope, id, props);

    this.dbSG = new ec2.SecurityGroup(this, 'DbSG', {
      vpc: props.vpc,
      description: 'RDS CDC source instance security group',
      allowAllOutbound: false,
    });

    // Bastion → DB ingress kept in this stack so it owns the SG rule lifecycle.
    // DMS → DB ingress is added in stack_dms.ts using CfnSecurityGroupIngress.
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

    // rds.logical_replication=1 switches wal_level to 'logical', which is required for DMS CDC.
    // It also auto-sets max_wal_senders and max_replication_slots — we override both to ensure
    // enough headroom for the DMS slot plus any monitoring connections.
    //
    // wal_sender_timeout=0: disables the WAL sender timeout. Without this, DMS connections drop
    // during low-traffic windows (default timeout is 30 000 ms). A dropped connection stops
    // heartbeats and freezes the replication slot LSN, causing WAL accumulation on the source.
    //
    // No rds.replica_identity_full or session_replication_role — those are Zero-ETL-specific.
    // DMS reads the full row image from the logical replication slot directly.
    const parameterGroup = new rds.ParameterGroup(this, 'ParameterGroup', {
      engine,
      parameters: {
        'rds.logical_replication': '1',
        wal_sender_timeout: '0',
        max_wal_senders: '10',
        max_replication_slots: '10',
      },
    });

    // t4g.micro: cheapest Graviton instance (~$13/mo). CDC reads WAL from the replication slot,
    // not from an additional DB connection, so the overhead at low write rates is minimal.
    // !! Scale up to t4g.small or larger for production workloads.
    this.instance = new rds.DatabaseInstance(this, 'Instance', {
      instanceIdentifier: 'rds-cdc-source',
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
      // Backup retention is required to maintain WAL for logical replication.
      // 1 day is sufficient for the demo; increase to 7+ days in production.
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

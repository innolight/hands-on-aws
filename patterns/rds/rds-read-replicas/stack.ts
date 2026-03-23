import * as cdk from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';

export const rdsReadReplicasStackName = 'RdsReadReplicas';

interface RdsReadReplicasStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  // RDS supports up to 15 read replicas per source instance.
  replicaCount?: number;
}

// Primary (R/W) --(async replication)--> Read Replica (R/O)
// Proxy sits in front — see stack_proxy.ts for connection pooling and replica routing.
export class RdsReadReplicasStack extends cdk.Stack {
  public readonly primary: rds.DatabaseInstance;
  public readonly dbSG: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: RdsReadReplicasStackProps) {
    super(scope, id, props);

    const replicaCount = props.replicaCount ?? 1;
    if (!Number.isInteger(replicaCount) || replicaCount < 1 || replicaCount > 15) {
      throw new Error(`replicaCount must be an integer between 1 and 15, got ${replicaCount}`);
    }

    // Primary and replicas share one SG. The proxy stack opens port 5432 on this SG via L1 ingress.
    this.dbSG = new ec2.SecurityGroup(this, 'DbSG', {
      vpc: props.vpc,
      description: 'RDS PostgreSQL read-replicas security group',
      allowAllOutbound: false,
    });

    this.primary = new rds.DatabaseInstance(this, 'Primary', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_17_7,
      }),
      // Primary can be scaled up independently from replicas when writes are the bottleneck.
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc: props.vpc,
      vpcSubnets: {subnetType: ec2.SubnetType.PRIVATE_ISOLATED},
      securityGroups: [this.dbSG],
      // Read replicas do not add HA — they are for read scaling and DR promotion.
      // Set multiAz=true on the primary only if you also need HA for writes.
      multiAz: false,
      credentials: rds.Credentials.fromGeneratedSecret('postgres'),
      databaseName: 'demo',
      // Replica inherits the source's allocated storage at creation; raise on the primary and the replica follows.
      allocatedStorage: 20,
      // Primary and replica can use different storage types — upgrade the replica to IO2 independently if it serves heavy reads.
      storageType: rds.StorageType.GP3,
      // Raise for expected data growth; replica inherits this ceiling independently.
      maxAllocatedStorage: 100,
      // backupRetention > 0 is required on the source instance; RDS refuses to create
      // a read replica from an instance with automated backups disabled.
      backupRetention: cdk.Duration.days(1),
      // !! Change the following in production.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
    });

    // DatabaseInstanceReadReplica inherits engine, credentials, and parameter group
    // from the source. You only specify placement and instance size.
    // Replication is asynchronous — a write on the primary may not yet be visible
    // on the replica. The /write-read-test endpoint in the demo server demonstrates this.
    for (let i = 1; i <= replicaCount; i++) {
      new rds.DatabaseInstanceReadReplica(this, `Replica${i}`, {
        sourceDatabaseInstance: this.primary,
        // Can be smaller than the primary for light reads, or larger for heavy analytical workloads.
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
        // For a cross-region replica, pass a VPC from the target region — CDK handles the rest.
        // Same region is simpler and has lower replication lag.
        vpc: props.vpc,
        vpcSubnets: {subnetType: ec2.SubnetType.PRIVATE_ISOLATED},
        securityGroups: [this.dbSG],
        // Can differ from the primary — upgrade to IO2 independently if this replica serves heavy reads.
        storageType: rds.StorageType.GP3,
        // Raise for expected growth; independent of the primary's ceiling.
        maxAllocatedStorage: 100,
        // !! Change the following in production.
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        // !! Enable in production for replicas you'd promote for DR — accidental deletion loses your standby.
        deletionProtection: false,
      });
    }

    new cdk.CfnOutput(this, 'SecretArn', {value: this.primary.secret!.secretArn});
    new cdk.CfnOutput(this, 'DbPort', {value: this.primary.dbInstanceEndpointPort});
    new cdk.CfnOutput(this, 'DatabaseName', {value: 'demo'});
  }
}

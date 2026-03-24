import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';

export const rdsReadableStandbysStackName = 'RdsReadableStandbys';

interface RdsReadableStandbysStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  bastionSG: ec2.SecurityGroup;
}

// Writer (AZ-1) --(sync)--> Standby (AZ-2) + Standby (AZ-3)
// Reader endpoint load-balances across both standbys.
// Demo server: localhost:5432 -> writer endpoint, localhost:5433 -> reader endpoint.
export class RdsReadableStandbysStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RdsReadableStandbysStackProps) {
    super(scope, id, props);

    const dbSG = new ec2.SecurityGroup(this, 'DbSG', {
      vpc: props.vpc,
      description: 'RDS Multi-AZ DB cluster security group',
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

    // L1 constructs do not auto-create a subnet group.
    const subnetGroup = new rds.CfnDBSubnetGroup(this, 'SubnetGroup', {
      dbSubnetGroupDescription: 'Isolated subnets for Multi-AZ DB cluster',
      subnetIds: props.vpc.isolatedSubnets.map((s) => s.subnetId),
    });

    // Multi-AZ DB cluster: CfnDBCluster with engine='postgres'
    // creates exactly 3 instances (1 writer + 2 readable standbys) across 3 AZs.
    // CloudFormation manages instance placement automatically.
    // L2 DatabaseCluster only accepts Aurora cluster engines (auroraPostgres, auroraMysql).
    // A standard RDS Multi-AZ DB cluster uses engine='postgres' on CfnDBCluster with
    const cluster = new rds.CfnDBCluster(this, 'Cluster', {
      engine: 'postgres',
      // Minor version upgrades can be done in-place; major upgrades require testing.
      // Multi-AZ DB clusters support PG 13.4+.
      engineVersion: '17.7',
      // Burstable (t-class) instances are NOT supported — db.m5d.large is the minimum.
      // Scale up to db.m5d.xlarge or db.r6gd.large for memory-heavy workloads.
      // Primary cost driver: 3 instances × ~$38/mo ≈ $115/mo.
      dbClusterInstanceClass: 'db.m5d.large',
      dbSubnetGroupName: subnetGroup.ref,
      vpcSecurityGroupIds: [dbSG.securityGroupId],
      // gp3 includes 3,000 IOPS and 125 MB/s baseline at no extra cost.
      // Upgrade to io2 for maximum durability (100× higher than io1) or >64,000 IOPS. gp2 is not supported.
      storageType: 'gp3',
      // maxAllocatedStorage (storage autoscaling) is not supported — provision upfront.
      allocatedStorage: 5,
      // iops not set: gp3 baseline 3,000 IOPS is included free.
      // Set explicitly to provision beyond the baseline (up to 64,000 total).
      iops: undefined,
      // manageMasterUserPassword delegates secret creation to RDS; the ARN is available
      // via attrMasterUserSecretSecretArn. The secret contains {username, password}.
      // Alternative: masterUserPassword — only for migration from existing credentials.
      manageMasterUserPassword: true,
      masterUsername: 'postgres',
      databaseName: 'demo',
      port: 5432,
      storageEncrypted: true,
      // !! Increase to 7–35 days in production for point-in-time restore.
      // Setting to 0 disables automated backups entirely.
      backupRetentionPeriod: 1,
      // !! Set to true in production.
      deletionProtection: false,
    });
    // applyRemovalPolicy(DESTROY) sets CloudFormation DeletionPolicy: Delete,
    // which skips the final snapshot and allows deletion without manual intervention.
    cluster.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    cluster.addDependency(subnetGroup);

    new cdk.CfnOutput(this, 'WriterEndpoint', { value: cluster.attrEndpointAddress });
    new cdk.CfnOutput(this, 'ReaderEndpoint', { value: cluster.attrReadEndpointAddress });
    new cdk.CfnOutput(this, 'DbPort', { value: cluster.attrEndpointPort });
    new cdk.CfnOutput(this, 'SecretArn', { value: cluster.attrMasterUserSecretSecretArn });
    new cdk.CfnOutput(this, 'DatabaseName', { value: cluster.databaseName! });
  }
}

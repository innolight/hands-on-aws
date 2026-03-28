import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as redshift from 'aws-cdk-lib/aws-redshift';

export const rdsRedshiftProvisionedStackName = 'RdsRedshiftZeroEtl-RedshiftProvisioned';

interface Props extends cdk.StackProps {
  rdsInstance: rds.DatabaseInstance;
  vpc: ec2.Vpc;
}

// RDS WAL → CfnIntegration → Redshift provisioned cluster (ra3.large, single-node)
// Cheaper than Serverless when a Zero-ETL CDC stream is active:
//   Provisioned ra3.large:  $0.649/hr
//   Serverless minimum:     $0.451/RPU-hr × 4 RPU = $1.80/hr
// dc2.large was the prior choice but is being retired by AWS and no longer available in eu-central-1.
export class RdsRedshiftProvisionedStack extends cdk.Stack {
  public readonly clusterArn: string;
  public readonly namespaceArn: string;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    const clusterIdentifier = 'redshift-provisioned-zero-etl';
    // Cluster ARN is not a CloudFormation return value for AWS::Redshift::Cluster,
    // so it is constructed from known inputs.
    this.clusterArn = `arn:aws:redshift:${this.region}:${this.account}:cluster:${clusterIdentifier}`;

    // enable_case_sensitive_identifier: required for Zero-ETL — PostgreSQL identifiers are
    // case-sensitive; Redshift defaults to case-insensitive, which breaks schema mapping.
    const parameterGroup = new redshift.CfnClusterParameterGroup(this, 'ParameterGroup', {
      description: 'Zero-ETL provisioned: enable case-sensitive identifiers',
      parameterGroupFamily: 'redshift-1.0',
      parameters: [{ parameterName: 'enable_case_sensitive_identifier', parameterValue: 'true' }],
    });

    // Subnet group spans all isolated subnets. Redshift requires subnets in at least
    // 2 AZs for the subnet group, even for a single-node cluster.
    const subnetGroup = new redshift.CfnClusterSubnetGroup(this, 'SubnetGroup', {
      description: 'Zero-ETL provisioned cluster subnet group',
      subnetIds: props.vpc.isolatedSubnets.map((s) => s.subnetId),
    });
    const dbName = 'dev';

    // ra3.large single-node: $0.649/hr in eu-central-1.
    // manageMasterPassword: Secrets Manager generates and rotates the admin credential.
    // No publiclyAccessible — queries use the Redshift Data API (IAM auth over HTTPS).
    // !! Change clusterType to 'multi-node' and set numberOfNodes ≥ 2 for production.
    const cluster = new redshift.CfnCluster(this, 'Cluster', {
      clusterIdentifier,
      clusterType: 'single-node',
      nodeType: 'ra3.large',
      dbName: dbName,
      masterUsername: 'admin',
      manageMasterPassword: true,
      clusterSubnetGroupName: subnetGroup.ref,
      clusterParameterGroupName: parameterGroup.ref,
      publiclyAccessible: false,

      // !! Change the following in production.
      automatedSnapshotRetentionPeriod: 1,
    });
    cluster.node.addDependency(parameterGroup);
    cluster.node.addDependency(subnetGroup);

    this.namespaceArn = cluster.attrClusterNamespaceArn;

    new cdk.CfnOutput(this, 'RedshiftClusterIdentifier', { value: cluster.clusterIdentifier! });
    new cdk.CfnOutput(this, 'RedshiftNamespaceArn', { value: this.namespaceArn });
    new cdk.CfnOutput(this, 'RedshiftDbName', { value: dbName });
    new cdk.CfnOutput(this, 'MasterUserSecretArn', { value: cluster.attrMasterPasswordSecretArn });
  }
}

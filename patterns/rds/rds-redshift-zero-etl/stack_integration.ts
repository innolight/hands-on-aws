import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as redshift from 'aws-cdk-lib/aws-redshift';

export const rdsRedshiftIntegrationStackName = 'RdsRedshiftZeroEtl-Integration';

interface Props extends cdk.StackProps {
  rdsInstance: rds.DatabaseInstance;
  clusterArn: string;
  namespaceArn: string;
}

// CfnIntegration streams WAL changes from the RDS instance into the Redshift cluster.
// Kept in a separate stack so that integration failures (e.g. resource policy not ready,
// integration config errors) do not cause a rollback of the Redshift cluster stack.
// Deploy order: RdsRedshiftZeroEtlRds → RdsRedshiftZeroEtlProvisioned → this stack.
export class RdsRedshiftIntegrationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    // RDS (non-Aurora) → Redshift Zero-ETL requires a resource policy on the Redshift namespace.

    const resourcePolicy = new RedshiftNamespaceResourcePolicy(this, 'ClusterResourcePolicy', {
      namespaceArn: props.namespaceArn,
      rdsInstanceArn: props.rdsInstance.instanceArn,
    });

    // Integration enters "Creating" state for ~10–30 min during CloudFormation deployment.
    // Once "Active", connect to Redshift (Query Editor v2 or Data API) and run:
    //   CREATE DATABASE demo FROM INTEGRATION '<integration-arn>';
    const integration = new rds.CfnIntegration(this, 'Integration', {
      integrationName: 'rds-to-redshift-provisioned',
      sourceArn: props.rdsInstance.instanceArn,
      targetArn: props.namespaceArn,
      // dataFilter: required for RDS PostgreSQL Zero-ETL — selects which database/schemas/tables
      // to replicate. Format: "include: db.schema.table" or "exclude: ...".
      // Replicates all schemas and tables from the 'demo' source RDS database.
      dataFilter: 'include: demo.*.*',
    });
    // Explicit dependency: ensure resource policy is applied before creating the integration
    // to avoid "Access Denied" errors during the initial validation check.
    integration.node.addDependency(resourcePolicy);

    new cdk.CfnOutput(this, 'IntegrationName', { value: integration.integrationName! });
  }
}

interface RedshiftNamespaceResourcePolicyProps {
  readonly namespaceArn: string;
  readonly rdsInstanceArn: string;
}

/**
 * Custom resource to manage Amazon Redshift Namespace resource policy for Zero-ETL.
 * Required for RDS (non-Aurora) sources even in the same account.
 */
class RedshiftNamespaceResourcePolicy extends Construct {
  constructor(scope: Construct, id: string, props: RedshiftNamespaceResourcePolicyProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    const putResourcePolicyCall: cr.AwsSdkCall = {
      service: 'Redshift',
      action: 'putResourcePolicy',
      parameters: {
        ResourceArn: props.namespaceArn,
        Policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { Service: 'redshift.amazonaws.com' },
              Action: ['redshift:AuthorizeInboundIntegration', 'redshift:CreateInboundIntegration'],
              Resource: props.namespaceArn,
              Condition: { StringEquals: { 'aws:SourceArn': props.rdsInstanceArn } },
            },
            {
              Effect: 'Allow',
              Principal: { AWS: `arn:aws:iam::${stack.account}:root` },
              Action: ['redshift:AuthorizeInboundIntegration', 'redshift:CreateInboundIntegration'],
              Resource: props.namespaceArn,
            },
          ],
        }),
      },
      physicalResourceId: cr.PhysicalResourceId.of(props.namespaceArn),
    };

    new cr.AwsCustomResource(this, 'Default', {
      onCreate: putResourcePolicyCall,
      onUpdate: putResourcePolicyCall,
      onDelete: {
        service: 'Redshift',
        action: 'deleteResourcePolicy',
        parameters: { ResourceArn: props.namespaceArn },
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['redshift:PutResourcePolicy', 'redshift:DeleteResourcePolicy'],
          resources: [props.namespaceArn],
        }),
      ]),
    });
  }
}

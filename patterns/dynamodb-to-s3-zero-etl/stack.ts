import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3tables from 'aws-cdk-lib/aws-s3tables';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';

export const dynamodbToS3StackName = 'DynamodbToS3';

// write to DynamoDB → Glue Zero-ETL replicates continuously → S3 Tables (Iceberg) → query with Athena
export class DynamodbToS3Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // TableV2 is required for Zero-ETL integrations; the legacy Table construct
    // does not expose the resource ARN format that Glue's source ARN expects.
    //
    // PITR must be enabled — Zero-ETL uses DynamoDB's point-in-time export
    // internally for the initial full snapshot before streaming changes.
    //
    // Schema: pk=ORDER#<orderId> | sk=ITEM#<itemId> | product | quantity | price | status
    const table = new dynamodb.TableV2(this, 'DemoTable', {
      tableName: 'zero-etl-demo',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      // PITR is mandatory for Zero-ETL — Glue uses it for the initial full-table export.
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // !! Change the following in production.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // DynamoDB resource policy: authorize Glue's Zero-ETL service to export from this table.
    // No CDK L1/L2 exists for DynamoDB resource policies, so we call the SDK directly.
    const dynamodbResourcePolicy = new cr.AwsCustomResource(this, 'DynamodbResourcePolicy', {
      onCreate: {
        service: 'DynamoDB',
        action: 'putResourcePolicy',
        parameters: {
          ResourceArn: table.tableArn,
          Policy: JSON.stringify({
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Principal: { Service: 'glue.amazonaws.com' },
                Action: [
                  'dynamodb:ExportTableToPointInTime',
                  'dynamodb:DescribeTable',
                  'dynamodb:DescribeExport',
                  'dynamodb:Scan',
                  'dynamodb:DescribeContinuousBackups',
                ],
                Resource: table.tableArn,
              },
            ],
          }),
        },
        physicalResourceId: cr.PhysicalResourceId.of(table.tableArn),
      },
      onDelete: {
        service: 'DynamoDB',
        action: 'deleteResourcePolicy',
        parameters: { ResourceArn: table.tableArn },
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [table.tableArn] }),
    });

    // S3 Table Bucket stores Iceberg tables. Account+region suffix ensures name uniqueness
    // across deployments. Table Buckets are separate from regular S3 buckets — they
    // speak the Apache Iceberg REST Catalog protocol and are not accessible via s3:// paths.
    const tableBucket = new s3tables.CfnTableBucket(this, 'TableBucket', {
      tableBucketName: `zero-etl-demo-${this.account}-${this.region}-v5`,
    });

    // Glue Database acts as the logical container and target for the Zero-ETL integration.
    // The locationUri points to the S3 Table Bucket where the Iceberg data will land.
    const glueDatabase = new glue.CfnDatabase(this, 'GlueDatabase', {
      catalogId: this.account,
      databaseInput: {
        name: 'zero_etl_demo_db_v5',
        locationUri: tableBucket.attrTableBucketArn,
      },
    });
    const glueDatabaseArn = `arn:aws:glue:${this.region}:${this.account}:database/${glueDatabase.ref}`;

    // IAM role that Glue assumes when writing to the S3 Table Bucket.
    // s3tables:* covers CreateTable, GetTable, PutRows — all required by the sink.
    const glueTargetRole = new iam.Role(this, 'GlueTargetRole', {
      assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
      inlinePolicies: {
        S3TablesBucketAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              // Full s3tables access scoped to this table bucket.
              actions: ['s3tables:*'],
              resources: [tableBucket.attrTableBucketArn, `${tableBucket.attrTableBucketArn}/*`],
            }),
            new iam.PolicyStatement({
              // Glue needs s3tables:GetTableBucket to resolve the catalog endpoint.
              actions: ['s3tables:GetTableBucket', 's3tables:ListTableBuckets'],
              resources: ['*'],
            }),
            new iam.PolicyStatement({
              // CloudWatch metrics for Zero-ETL integration health monitoring.
              actions: ['cloudwatch:PutMetricData'],
              resources: ['*'],
              conditions: {
                StringEquals: { 'cloudwatch:namespace': 'AWS/Glue/ZeroETL' },
              },
            }),
            new iam.PolicyStatement({
              // Glue writes integration logs to CloudWatch Logs for observability.
              actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
              resources: ['arn:aws:logs:*:*:log-group:/aws/glue/*'],
            }),
          ],
        }),
      },
    });

    // Glue catalog resource policy: required for cross-service Zero-ETL authorization.
    // Two statements are needed (dual-auth model):
    //   AuthorizeInboundIntegration — authorizes Glue service to manage data push
    //   CreateInboundIntegration — allows the caller to create the integration
    // EnableHybrid must be TRUE to merge this policy with the Glue default policy instead
    // of replacing it — without this, Glue's own internal access breaks.
    //
    // The policy resource is the Data Catalog. Using both the catalog and database ARNs
    // to satisfy Glue's validation regex.
    const glueAccountId = this.account;
    const glueCatalogArn = `arn:aws:glue:${this.region}:${glueAccountId}:catalog`;
    const glueCatalogPolicy = new cr.AwsCustomResource(this, 'GlueCatalogPolicy', {
      onCreate: {
        service: 'Glue',
        action: 'putResourcePolicy',
        parameters: {
          PolicyInJson: JSON.stringify({
            Version: '2012-10-17',
            Statement: [
              {
                // Glue service principal authorizes itself to manage the inbound data flow.
                Effect: 'Allow',
                Principal: { Service: 'glue.amazonaws.com' },
                Action: 'glue:AuthorizeInboundIntegration',
                Resource: [glueCatalogArn, glueDatabaseArn],
              },
              {
                // Glue allows the principal in this account to create the integration.
                Effect: 'Allow',
                Principal: { AWS: `arn:aws:iam::${glueAccountId}:root` },
                Action: 'glue:CreateInboundIntegration',
                Resource: [glueCatalogArn, glueDatabaseArn],
              },
            ],
          }),
          EnableHybrid: 'TRUE',
        },
        physicalResourceId: cr.PhysicalResourceId.of(`glue-catalog-policy-${this.account}`),
      },
      onDelete: {
        service: 'Glue',
        action: 'deleteResourcePolicy',
        parameters: {},
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['glue:PutResourcePolicy', 'glue:DeleteResourcePolicy'],
          resources: [glueCatalogArn],
        }),
      ]),
    });

    // Zero-ETL integration: continuously replicates DynamoDB changes to S3 Tables.
    // Glue polls DynamoDB's change stream (via DynamoDB Streams internally) after
    // an initial PITR snapshot, applying changes with ~15-minute latency.
    // The target is the Glue Database ARN.
    const integration = new glue.CfnIntegration(this, 'ZeroEtlIntegration', {
      integrationName: 'dynamodb-to-s3tables-v5',
      sourceArn: table.tableArn,
      targetArn: glueDatabaseArn,
    });
    // Integration creation requires the resource policies and database to exist first.
    integration.node.addDependency(dynamodbResourcePolicy);
    integration.node.addDependency(glueCatalogPolicy);
    integration.node.addDependency(glueDatabase);

    // Source resource property: DynamoDB side — no extra processing config needed
    // for DynamoDB sources (connection/VPC config is only for SaaS/JDBC sources).
    const sourceResourceProp = new glue.CfnIntegrationResourceProperty(this, 'SourceResourceProp', {
      resourceArn: table.tableArn,
    });
    sourceResourceProp.node.addDependency(integration);

    // Target resource property: S3 Tables side — roleArn grants Glue write access
    // to the table bucket when landing the Iceberg data.
    const targetResourceProp = new glue.CfnIntegrationResourceProperty(this, 'TargetResourceProp', {
      resourceArn: glueDatabaseArn,
      targetProcessingProperties: {
        roleArn: glueTargetRole.roleArn,
      },
    });
    targetResourceProp.node.addDependency(integration);

    // Athena results bucket: stores query output files in CSV format.
    // !! Change the following in production.
    const athenaResultsBucket = new s3.Bucket(this, 'AthenaResultsBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Athena WorkGroup: engine v3 for Iceberg support (v3 introduced native Iceberg reads).
    // recursiveDeleteOption allows stack teardown to delete the workgroup even if it
    // contains saved queries — safe for a demo, review before enabling in production.
    const workGroup = new athena.CfnWorkGroup(this, 'AthenaWorkGroup', {
      name: 'zero-etl-demo',
      workGroupConfiguration: {
        engineVersion: { selectedEngineVersion: 'Athena engine version 3' },
        resultConfiguration: {
          outputLocation: `s3://${athenaResultsBucket.bucketName}/results/`,
        },
      },
      recursiveDeleteOption: true,
    });

    new cdk.CfnOutput(this, 'OutputTableName', { key: 'TableName', value: table.tableName });
    new cdk.CfnOutput(this, 'OutputTableBucketArn', { key: 'TableBucketArn', value: tableBucket.attrTableBucketArn });
    new cdk.CfnOutput(this, 'OutputAthenaWorkGroup', { key: 'AthenaWorkGroupName', value: workGroup.name });
    new cdk.CfnOutput(this, 'OutputAthenaResultsBucket', {
      key: 'AthenaResultsBucket',
      value: athenaResultsBucket.bucketName,
    });
    new cdk.CfnOutput(this, 'OutputIntegrationName', { key: 'IntegrationName', value: integration.integrationName });
  }
}

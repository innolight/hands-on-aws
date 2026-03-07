import * as cdk from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as s3tables from 'aws-cdk-lib/aws-s3tables';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';

export const s3TablesStackName = 'S3Tables';

// create S3 Table Bucket + Iceberg sales table → load data and run analytics with Athena
export class S3TablesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // S3 Table Buckets store Iceberg tables — automatic compaction merges small Parquet files,
    // snapshot management enables time travel, unreferenced file removal reclaims storage from
    // aborted writes. Not accessible via s3:// paths — access is through the Iceberg REST
    // Catalog endpoint at s3tables.<region>.amazonaws.com.
    // Account+region suffix ensures name uniqueness across deployments.
    const tableBucket = new s3tables.CfnTableBucket(this, 'TableBucket', {
      tableBucketName: `sales-demo-${this.account}-${this.region}`,
    });

    // Namespaces are logical groupings within a table bucket — analogous to a database schema
    // in SQL. Required before creating tables; one bucket can hold multiple namespaces.
    const namespace = new s3tables.CfnNamespace(this, 'Namespace', {
      namespace: 'sales_ns',
      tableBucketArn: tableBucket.attrTableBucketArn,
    });

    // Defining the schema in CDK means the table exists at deploy time — no Athena CREATE TABLE needed.
    // Column names must be lowercase — Glue and Athena reject uppercase with GENERIC_INTERNAL_ERROR.
    // openTableFormat: 'ICEBERG' is the only supported value — S3 Tables only stores Iceberg format.
    // Alternative: create via Athena DDL after deploy — more flexible types (e.g. DATE instead of STRING)
    // but requires an extra step before the demo server starts.
    const salesTable = new s3tables.CfnTable(this, 'SalesTable', {
      tableName: 'sales',
      namespace: 'sales_ns',
      tableBucketArn: tableBucket.attrTableBucketArn,
      openTableFormat: 'ICEBERG',
      icebergMetadata: {
        icebergSchema: {
          schemaFieldList: [
            {name: 'sale_date',    type: 'string', required: true},
            {name: 'product',      type: 'string', required: true},
            {name: 'category',     type: 'string', required: true},
            {name: 'region',       type: 'string', required: true},
            {name: 'quantity',     type: 'int',    required: true},
            {name: 'unit_price',   type: 'double', required: true},
            {name: 'total_amount', type: 'double', required: true},
          ],
        },
      },
    });
    salesTable.addDependency(namespace);

    // Grant IAM_ALLOWED_PRINCIPALS access to the federated database and table so Athena queries work.
    // Lake Formation checks permissions at the bucket-specific sub-catalog level (s3tablescatalog/<bucket>),
    // not the parent s3tablescatalog — so catalog-level grants in the setup stack don't cascade here.
    const lfGrants = new cr.AwsCustomResource(this, 'LakeFormationGrants', {
      onCreate: {
        service: 'LakeFormation',
        action: 'batchGrantPermissions',
        parameters: {
          Entries: [
            {
              Id: 'db-grant',
              Principal: {DataLakePrincipalIdentifier: 'IAM_ALLOWED_PRINCIPALS'},
              Resource: {Database: {CatalogId: `${this.account}:s3tablescatalog/${tableBucket.tableBucketName}`, Name: 'sales_ns'}},
              Permissions: ['ALL'],
            },
            {
              Id: 'table-grant',
              Principal: {DataLakePrincipalIdentifier: 'IAM_ALLOWED_PRINCIPALS'},
              Resource: {Table: {CatalogId: `${this.account}:s3tablescatalog/${tableBucket.tableBucketName}`, DatabaseName: 'sales_ns', Name: 'sales'}},
              Permissions: ['ALL'],
            },
          ],
        },
        physicalResourceId: cr.PhysicalResourceId.of('lf-grants'),
        // Gracefully skip if the LF setup stack hasn't been deployed yet
        ignoreErrorCodesMatching: 'AccessDeniedException|InvalidInputException',
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['lakeformation:BatchGrantPermissions', 'lakeformation:GrantPermissions'],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          // LF validates catalog existence via Glue with the caller's credentials
          actions: ['glue:GetCatalog'],
          resources: [
            `arn:aws:glue:${this.region}:${this.account}:catalog`,
            `arn:aws:glue:${this.region}:${this.account}:catalog/s3tablescatalog`,
            `arn:aws:glue:${this.region}:${this.account}:catalog/s3tablescatalog/${tableBucket.tableBucketName}`,
          ],
        }),
      ]),
    });
    lfGrants.node.addDependency(salesTable);

    // Bucket for Athena query results — required for Athena workgroup configuration
    const athenaResultsBucket = new s3.Bucket(this, 'AthenaResultsBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      // !! Change the following in production.
      autoDeleteObjects: true,
    });

    // Athena engine v3 has native Iceberg support — reads column-level metadata from Iceberg
    // manifests, enabling partition pruning and predicate pushdown without a Glue Crawler.
    // recursiveDeleteOption allows cdk destroy to remove the workgroup even if it has saved queries.
    const workGroup = new athena.CfnWorkGroup(this, 'AthenaWorkGroup', {
      name: 's3-tables-demo',
      workGroupConfiguration: {
        engineVersion: {selectedEngineVersion: 'Athena engine version 3'},
        resultConfiguration: {
          outputLocation: `s3://${athenaResultsBucket.bucketName}/results/`,
        },
      },
      recursiveDeleteOption: true,
    });

    new cdk.CfnOutput(this, 'OutputTableBucketName',     {key: 'TableBucketName',      value: tableBucket.tableBucketName});
    new cdk.CfnOutput(this, 'OutputNamespace',           {key: 'Namespace',            value: 'sales_ns'});
    new cdk.CfnOutput(this, 'OutputTableName',           {key: 'TableName',            value: 'sales'});
    new cdk.CfnOutput(this, 'OutputAthenaWorkGroup',     {key: 'AthenaWorkGroupName',  value: workGroup.name});
    new cdk.CfnOutput(this, 'OutputAthenaResultsBucket', {key: 'AthenaResultsBucket',  value: athenaResultsBucket.bucketName});
  }
}

import * as cdk from 'aws-cdk-lib';
import {Template, Match} from 'aws-cdk-lib/assertions';
import {S3TablesStack} from './stack';

describe('S3TablesStack', () => {
  const app = new cdk.App();
  const stack = new S3TablesStack(app, 'TestStack', {
    env: {account: '123456789012', region: 'eu-central-1'},
  });
  const template = Template.fromStack(stack);

  test('S3 Table Bucket has account and region in name', () => {
    template.hasResourceProperties('AWS::S3Tables::TableBucket', {
      TableBucketName: 'sales-demo-123456789012-eu-central-1',
    });
  });

  test('Namespace is created with correct name', () => {
    template.hasResourceProperties('AWS::S3Tables::Namespace', {
      Namespace: 'sales_ns',
    });
  });

  test('Iceberg table has correct name, namespace, and format', () => {
    template.hasResourceProperties('AWS::S3Tables::Table', {
      TableName: 'sales',
      Namespace: 'sales_ns',
      OpenTableFormat: 'ICEBERG',
    });
  });

  test('Iceberg table schema has all 7 columns with correct types', () => {
    template.hasResourceProperties('AWS::S3Tables::Table', {
      IcebergMetadata: {
        IcebergSchema: {
          SchemaFieldList: Match.arrayWith([
            {Name: 'sale_date',    Type: 'string', Required: true},
            {Name: 'product',      Type: 'string', Required: true},
            {Name: 'category',     Type: 'string', Required: true},
            {Name: 'region',       Type: 'string', Required: true},
            {Name: 'quantity',     Type: 'int',    Required: true},
            {Name: 'unit_price',   Type: 'double', Required: true},
            {Name: 'total_amount', Type: 'double', Required: true},
          ]),
        },
      },
    });
  });

  test('Athena WorkGroup uses engine v3', () => {
    template.hasResourceProperties('AWS::Athena::WorkGroup', {
      Name: 's3-tables-demo',
      WorkGroupConfiguration: {
        EngineVersion: {SelectedEngineVersion: 'Athena engine version 3'},
      },
      RecursiveDeleteOption: true,
    });
  });

  test('Athena WorkGroup result location points to results bucket', () => {
    template.hasResourceProperties('AWS::Athena::WorkGroup', {
      WorkGroupConfiguration: {
        ResultConfiguration: {
          OutputLocation: Match.objectLike({'Fn::Join': Match.anyValue()}),
        },
      },
    });
  });

  test('Stack has 5 outputs', () => {
    template.hasOutput('TableBucketName', {});
    template.hasOutput('Namespace', {});
    template.hasOutput('TableName', {});
    template.hasOutput('AthenaWorkGroupName', {});
    template.hasOutput('AthenaResultsBucket', {});
  });
});

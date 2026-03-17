import * as cdk from 'aws-cdk-lib';
import {Template} from 'aws-cdk-lib/assertions';
import {S3TablesStack} from './stack';

describe('S3TablesStack', () => {
  const app = new cdk.App();
  const stack = new S3TablesStack(app, 'TestStack', {
    env: {account: '123456789012', region: 'eu-central-1'},
  });
  const template = Template.fromStack(stack);

  test('table bucket name embeds account and region', () => {
    template.hasResourceProperties('AWS::S3Tables::TableBucket', {
      TableBucketName: 'sales-demo-123456789012-eu-central-1',
    });
  });

  test('Iceberg table is created with correct name, namespace, and format', () => {
    template.hasResourceProperties('AWS::S3Tables::Table', {
      TableName: 'sales',
      Namespace: 'sales_ns',
      OpenTableFormat: 'ICEBERG',
    });
  });

  test('Athena WorkGroup uses engine v3', () => {
    template.hasResourceProperties('AWS::Athena::WorkGroup', {
      Name: 's3-tables-demo',
      WorkGroupConfiguration: {
        EngineVersion: {SelectedEngineVersion: 'Athena engine version 3'},
      },
    });
  });

  test('exposes 5 stack outputs', () => {
    template.hasOutput('TableBucketName', {});
    template.hasOutput('Namespace', {});
    template.hasOutput('TableName', {});
    template.hasOutput('AthenaWorkGroupName', {});
    template.hasOutput('AthenaResultsBucket', {});
  });
});

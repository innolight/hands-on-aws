import * as cdk from 'aws-cdk-lib';
import { Template, Match, Annotations } from 'aws-cdk-lib/assertions';
import { S3TablesLakeFormationSetupStack } from './setup_stack';

describe('S3TablesLakeFormationSetupStack', () => {
  const app = new cdk.App({ context: { lfAdmin: 'arn:aws:iam::123456789012:user/TestUser' } });
  const stack = new S3TablesLakeFormationSetupStack(app, 'TestSetupStack', {
    env: { account: '123456789012', region: 'eu-central-1' },
  });
  const template = Template.fromStack(stack);

  test('creates IAM role trusted by lakeformation.amazonaws.com with known name', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'S3TablesRoleForLakeFormation',
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([Match.objectLike({ Principal: { Service: 'lakeformation.amazonaws.com' } })]),
      }),
    });
  });

  test('creates 5 custom resources (Lambda bootstrap, LF admin, LF registration, Glue catalog, principal grants)', () => {
    template.resourceCountIs('Custom::AWS', 5);
  });

  test('emits error annotation if lfAdmin context is missing', () => {
    const appNoContext = new cdk.App();
    const missingContextStack = new S3TablesLakeFormationSetupStack(appNoContext, 'NoContextStack', {
      env: { account: '123456789012', region: 'eu-central-1' },
    });
    Annotations.fromStack(missingContextStack).hasError('*', Match.stringLikeRegexp('lfAdmin'));
  });

  test('exposes LakeFormationRoleArn and GlueCatalogName as outputs', () => {
    template.hasOutput('LakeFormationRoleArn', {});
    template.hasOutput('GlueCatalogName', {});
  });
});

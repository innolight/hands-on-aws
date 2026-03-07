import * as cdk from 'aws-cdk-lib';
import {Template, Match} from 'aws-cdk-lib/assertions';
import {S3TablesLakeFormationSetupStack} from './setup_stack';

describe('S3TablesLakeFormationSetupStack', () => {
  const app = new cdk.App({context: {lfAdmin: 'arn:aws:iam::123456789012:user/TestUser'}});
  const stack = new S3TablesLakeFormationSetupStack(app, 'TestSetupStack', {
    env: {account: '123456789012', region: 'eu-central-1'},
  });
  const template = Template.fromStack(stack);

  test('IAM role for Lake Formation has correct name and trust policy', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'S3TablesRoleForLakeFormation',
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: {Service: 'lakeformation.amazonaws.com'},
            Action: 'sts:AssumeRole',
          }),
        ]),
      }),
    });
  });

  test('IAM role has s3tables inline policy', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      Policies: Match.arrayWith([
        Match.objectLike({
          PolicyName: 'S3TablesAccess',
          PolicyDocument: Match.objectLike({
            Statement: Match.arrayWith([
              Match.objectLike({
                Action: 's3tables:ListTableBuckets',
                Resource: '*',
              }),
            ]),
          }),
        }),
      ]),
    });
  });

  test('creates 5 custom resources (Lambda bootstrap, LF admin, LF registration, Glue catalog, Principal grants)', () => {
    template.resourceCountIs('Custom::AWS', 5);
  });

  test('throws if lfAdmin context is missing', () => {
    const appNoContext = new cdk.App();
    expect(() => new S3TablesLakeFormationSetupStack(appNoContext, 'NoContextStack', {
      env: {account: '123456789012', region: 'eu-central-1'},
    })).toThrow(/lfAdmin/);
  });

  test('stack has 2 outputs', () => {
    template.hasOutput('LakeFormationRoleArn', {});
    template.hasOutput('GlueCatalogName', {});
  });
});

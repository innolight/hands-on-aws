import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';

export const s3TablesLakeFormationSetupStackName = 'S3TablesLakeFormationSetup';

// IAM role → LF registration → Glue federated catalog → Athena can query S3 Tables
export class S3TablesLakeFormationSetupStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const s3TablesResourceArn = `arn:aws:s3tables:${this.region}:${this.account}:bucket/*`;

    // The service-linked role (AWSServiceRoleForLakeFormationDataAccess) only has s3:ListAllMyBuckets —
    // it cannot access S3 Tables. A custom role with s3tables:* permissions is required.
    const lakeFormationRole = new iam.Role(this, 'S3TablesRoleForLakeFormation', {
      roleName: 'S3TablesRoleForLakeFormation',
      assumedBy: new iam.ServicePrincipal('lakeformation.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
        },
      }),
      inlinePolicies: {
        S3TablesAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['s3tables:ListTableBuckets'],
              resources: ['*'],
            }),
            new iam.PolicyStatement({
              actions: [
                's3tables:GetTableBucket',
                's3tables:CreateNamespace',
                's3tables:GetNamespace',
                's3tables:ListNamespaces',
                's3tables:DeleteNamespace',
                's3tables:CreateTable',
                's3tables:DeleteTable',
                's3tables:GetTable',
                's3tables:ListTables',
                's3tables:GetTableMetadataLocation',
                's3tables:UpdateTableMetadataLocation',
                's3tables:GetTableData',
                's3tables:PutTableData',
              ],
              resources: [s3TablesResourceArn],
            }),
          ],
        }),
      },
    });
    // sts:AssumeRole is implicit via assumedBy, but Lake Formation also needs SetContext and SetSourceIdentity
    lakeFormationRole.assumeRolePolicy!.addStatements(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('lakeformation.amazonaws.com')],
        actions: ['sts:SetContext', 'sts:SetSourceIdentity'],
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
        },
      }),
    );

    // Lake Formation rejects temporary-credential ARNs (sts::assumed-role/...), so we can't
    // auto-discover the deployer via GetCallerIdentity inside a Lambda. Pass the permanent
    // IAM user/role ARN via CDK context: -c lfAdmin=arn:aws:iam::123456789012:user/MyUser
    const lfAdminArn = this.node.tryGetContext('lfAdmin') ?? 'PLACEHOLDER';
    if (lfAdminArn === 'PLACEHOLDER') {
      // Annotation instead of throw — lets other stacks synthesize unaffected.
      // Deploy will fail; synth of this stack produces a warning-marked template.
      cdk.Annotations.of(this).addError(
        'Required context variable "lfAdmin" not set. Pass -c lfAdmin=<your IAM user/role ARN>',
      );
    }

    // All AwsCustomResources in this stack share one singleton Lambda (AWS679f53...).
    // That Lambda calls glue:createCatalog, which checks LF permissions on the caller.
    // We must include the Lambda's role in DataLakeAdmins so it passes LF's permission check.
    // Bootstrap a no-op resource first so we can reference the Lambda role ARN as a CF token.
    const lambdaBootstrap = new cr.AwsCustomResource(this, 'LambdaBootstrap', {
      onCreate: {
        service: 'STS',
        action: 'getCallerIdentity',
        physicalResourceId: cr.PhysicalResourceId.of('lambda-bootstrap'),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE }),
    });
    const lambdaRoleArn = (lambdaBootstrap.grantPrincipal as iam.IRole).roleArn;

    // Add the deploying user AND the Lambda execution role as Lake Formation admins.
    // The user ARN is needed to manage LF after deploy; the Lambda role ARN is needed so
    // the same Lambda can call glue:createCatalog (which validates LF permissions on the caller).
    // Left in place on destroy to avoid locking yourself out.
    const lfAdmin = new cr.AwsCustomResource(this, 'LakeFormationAdmin', {
      onCreate: {
        service: 'LakeFormation',
        action: 'putDataLakeSettings',
        parameters: {
          DataLakeSettings: {
            DataLakeAdmins: [
              { DataLakePrincipalIdentifier: lfAdminArn },
              { DataLakePrincipalIdentifier: lambdaRoleArn },
            ],
            CreateDatabaseDefaultPermissions: [
              {
                Principal: { DataLakePrincipalIdentifier: 'IAM_ALLOWED_PRINCIPALS' },
                Permissions: ['ALL'],
              },
            ],
            CreateTableDefaultPermissions: [
              {
                Principal: { DataLakePrincipalIdentifier: 'IAM_ALLOWED_PRINCIPALS' },
                Permissions: ['ALL'],
              },
            ],
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of('lf-admin-settings'),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['lakeformation:PutDataLakeSettings', 'lakeformation:GetDataLakeSettings'],
          resources: ['*'],
        }),
      ]),
    });
    lfAdmin.node.addDependency(lambdaBootstrap);

    // Register S3 Tables as a Lake Formation data location using the custom role.
    // withFederation + withPrivilegedAccess enable Athena to query via the federated catalog.
    const lfRegistration = new cr.AwsCustomResource(this, 'LakeFormationRegistration', {
      onCreate: {
        service: 'LakeFormation',
        action: 'registerResource',
        parameters: {
          ResourceArn: s3TablesResourceArn,
          RoleArn: lakeFormationRole.roleArn,
          WithFederation: true,
          // SDK v3 field name is HybridAccessEnabled (maps to --with-privileged-access in CLI)
          HybridAccessEnabled: true,
        },
        physicalResourceId: cr.PhysicalResourceId.of('lf-s3tables-registration'),
      },
      onDelete: {
        service: 'LakeFormation',
        action: 'deregisterResource',
        parameters: {
          ResourceArn: s3TablesResourceArn,
        },
        // Ignore "not registered" errors during rollback/destroy when registration never completed
        ignoreErrorCodesMatching: 'EntityNotFoundException|InvalidInputException',
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['lakeformation:RegisterResource', 'lakeformation:DeregisterResource'],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          // Lake Formation needs iam:PassRole to assume the custom role during registration,
          // and iam:GetRole during deregistration to validate the role still exists.
          actions: ['iam:PassRole', 'iam:GetRole'],
          resources: [lakeFormationRole.roleArn],
        }),
      ]),
    });
    lfRegistration.node.addDependency(lfAdmin);

    // Federated catalog in Glue — bridges S3 Tables to Athena.
    // AllowFullTableExternalDataAccess: true lets Athena access federated tables without per-table LF grants.
    const glueCatalog = new cr.AwsCustomResource(this, 'GlueFederatedCatalog', {
      onCreate: {
        service: 'Glue',
        action: 'createCatalog',
        parameters: {
          Name: 's3tablescatalog',
          CatalogInput: {
            FederatedCatalog: {
              Identifier: s3TablesResourceArn,
              ConnectionName: 'aws:s3tables',
            },
            CreateDatabaseDefaultPermissions: [],
            CreateTableDefaultPermissions: [],
            AllowFullTableExternalDataAccess: 'True',
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of('glue-s3tables-catalog'),
      },
      onDelete: {
        service: 'Glue',
        action: 'deleteCatalog',
        parameters: {
          CatalogId: 's3tablescatalog',
        },
        // Ignore "not found" errors during rollback/destroy when catalog was never created
        ignoreErrorCodesMatching: 'EntityNotFoundException',
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['glue:CreateCatalog', 'glue:DeleteCatalog'],
          resources: [
            `arn:aws:glue:${this.region}:${this.account}:catalog`,
            `arn:aws:glue:${this.region}:${this.account}:catalog/s3tablescatalog`,
          ],
        }),
        new iam.PolicyStatement({
          // createCatalog with a FederatedCatalog requires PassConnection on the aws:s3tables connection
          actions: ['glue:PassConnection'],
          resources: [`arn:aws:glue:${this.region}:${this.account}:connection/aws:s3tables`],
        }),
      ]),
    });
    glueCatalog.node.addDependency(lfRegistration);

    // Grant IAM_ALLOWED_PRINCIPALS ALL on the s3tablescatalog so any IAM-authorized caller can query.
    const principalGrants = new cr.AwsCustomResource(this, 'PrincipalGrants', {
      onCreate: {
        service: 'LakeFormation',
        action: 'grantPermissions',
        parameters: {
          Principal: { DataLakePrincipalIdentifier: 'IAM_ALLOWED_PRINCIPALS' },
          Resource: { Catalog: { Id: `${this.account}:s3tablescatalog` } },
          Permissions: ['ALL'],
        },
        physicalResourceId: cr.PhysicalResourceId.of('principal-grants'),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['lakeformation:BatchGrantPermissions', 'lakeformation:GrantPermissions'],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          // LF validates catalog existence by calling Glue internally with the caller's credentials
          actions: ['glue:GetCatalog'],
          resources: [
            `arn:aws:glue:${this.region}:${this.account}:catalog`,
            `arn:aws:glue:${this.region}:${this.account}:catalog/s3tablescatalog`,
          ],
        }),
      ]),
    });
    principalGrants.node.addDependency(glueCatalog);

    new cdk.CfnOutput(this, 'OutputRoleArn', { key: 'LakeFormationRoleArn', value: lakeFormationRole.roleArn });
    new cdk.CfnOutput(this, 'OutputCatalogName', { key: 'GlueCatalogName', value: 's3tablescatalog' });
  }
}

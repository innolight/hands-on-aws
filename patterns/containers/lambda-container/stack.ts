import * as cdk from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as logs from 'aws-cdk-lib/aws-logs';

export const lambdaContainerStackName = 'LambdaContainerStack';

// Function URL → Lambda (LWA) → Express :3000
// LWA bridges Lambda's invoke event to the HTTP server running in the same container
export class LambdaContainerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // fromRepositoryName avoids a cross-stack reference — the ECR stack need not be deployed first
    const repository = ecr.Repository.fromRepositoryName(this, 'Repo', 'hands-on-containers');

    // Secrets Manager dynamic reference ({{resolve:secretsmanager:...}}) is resolved by
    // CloudFormation at deploy time — the plaintext value never appears in the template.
    // SSM SecureString dynamic references are NOT supported in Lambda env vars.
    const apiKeySecret = new secretsmanager.Secret(this, 'ApiKey', {
      description: 'API key for the container Express server',
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 32,
      },
      // !! Change the following in production.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Explicit log group so removalPolicy: DESTROY takes effect on cdk destroy.
    // Lambda auto-creates a log group if absent, but CDK cannot control the removal policy of auto-created groups.
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: '/aws/lambda/lambda-container',
      // !! Change the following in production.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: logs.RetentionDays.ONE_WEEK,
    });

    const fn = new lambda.DockerImageFunction(this, 'Function', {
      // DockerImageCode.fromEcr auto-grants ecr:GetDownloadUrlForLayer, ecr:BatchGetImage,
      // ecr:GetAuthorizationToken on the execution role — no manual ECR policy needed.
      // Tag 'lambda' coexists with 'latest' (used by ECS patterns) in the same ECR repository.
      code: lambda.DockerImageCode.fromEcr(repository, {tagOrDigest: 'lambda'}),
      // ARM64 (Graviton) is ~20% cheaper than x86 and consistent with ECS patterns
      architecture: lambda.Architecture.ARM_64,
      // 512 MB: Lambda container cold start scales with memory allocation;
      // 512 MB keeps cold start under 3s while remaining cost-effective
      memorySize: 512,
      // 30s: headroom for 1–3s container cold start; Function URL is synchronous,
      // so a timeout surfaces as a 500 to the caller — err on the side of leniency
      timeout: cdk.Duration.seconds(30),
      // reservedConcurrentExecutions carves out a dedicated slice of account concurrency
      // for this function — prevents a traffic spike from starving other functions, and
      // limits this function's own scaling (useful for protecting downstream dependencies).
      // Unnecessary when the function is the only one in the account or when downstream
      // services can handle unlimited concurrent calls.
      // 1: low value to stay within the default account quota (10 unreserved minimum);
      // increase after requesting a higher concurrency quota in Service Quotas
      // reservedConcurrentExecutions: 1,
      environment: {
        API_KEY: apiKeySecret.secretValue.unsafeUnwrap(),
      },
      logGroup,
    });

    // AuthType.NONE: app-level x-api-key middleware handles auth (consistent with all patterns).
    // Function URL has no per-request cost — unlike API Gateway.
    const fnUrl = fn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    // Uncomment to eliminate cold starts (~$15/mo for 1 provisioned instance).
    // Requires a function version + alias; provisioned concurrency cannot be set on $LATEST.
    // const version = fn.currentVersion;
    // const alias = new lambda.Alias(this, 'LiveAlias', {
    //   aliasName: 'live',
    //   version,
    //   provisionedConcurrentExecutions: 1,
    // });

    new cdk.CfnOutput(this, 'FunctionUrl', {value: fnUrl.url});
    new cdk.CfnOutput(this, 'FunctionArn', {value: fn.functionArn});
    new cdk.CfnOutput(this, 'ApiKeySecretArn', {value: apiKeySecret.secretArn});
  }
}

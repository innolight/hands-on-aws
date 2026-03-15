import * as cdk from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as ecr from 'aws-cdk-lib/aws-ecr';

export const elasticContainerRegistryStackName = "ElasticContainerRegistryStack";

// API key is created manually via CLI (CloudFormation cannot create SSM SecureString parameters)
export const apiKeyParameterName = '/hands-on-aws/containers/api-key';

// ECR repository + SSM SecureString parameter name for the shared API key
// All compute patterns (app-runner, ecs-fargate, lambda-container, etc.) depend on this stack
export class ElasticContainerRegistryStack extends cdk.Stack {
  public readonly repository: ecr.Repository;
  public readonly apiKeyParameterName: string = apiKeyParameterName;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // !! Change the following in production.
    // removalPolicy DESTROY + emptyOnDelete: true allows `cdk destroy` to clean up the repo
    this.repository = new ecr.Repository(this, 'Repository', {
      repositoryName: 'hands-on-containers',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      lifecycleRules: [
        {
          // Untagged images accumulate on every `docker push` — expire them quickly to avoid storage costs
          description: 'Expire untagged images after 1 day',
          tagStatus: ecr.TagStatus.UNTAGGED,
          maxImageAge: cdk.Duration.days(1),
        },
      ],
    });

    new cdk.CfnOutput(this, 'RepositoryUri', {value: this.repository.repositoryUri});
    new cdk.CfnOutput(this, 'RepositoryName', {value: this.repository.repositoryName});
    new cdk.CfnOutput(this, 'ApiKeyParameterName', {value: this.apiKeyParameterName});
  }
}

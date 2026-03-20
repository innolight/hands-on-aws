#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import {S3EventsNotification, s3EventsNotificationStackName} from '../patterns/s3-events-notification/stack';
import {S3CrossRegionReplicationStackStep1} from "../patterns/s3-cross-region-replication/stack_step1_destination_bucket";
import {
  S3CrossRegionReplicationStackStep2
} from "../patterns/s3-cross-region-replication/stack_step2_source_bucket";
import {S3PolishedConfigurationStack} from "../patterns/s3-polished-configuration/stack";
import {S3StaticWebsiteCloudfrontStack, s3StaticWebsiteCloudfrontStackName} from "../patterns/s3-static-website-cloudfront/stack";
import {S3LambdaRekognitionDynamodbStack, s3LambdaRekognitionDynamodbStackName} from '../patterns/s3-lambda-rekognition-dynamodb/stack';
import {S3BehindSftpStack, s3BehindSftpStackName} from '../patterns/s3-behind-sftp/stack';
import {DynamodbGlobalDatabaseStack, dynamodbGlobalDatabaseStackName} from '../patterns/dynamodb-global-database/stack';
import {S3VectorsStack, s3VectorsStackName} from '../patterns/s3-vectors-bucket/stack';
import {DynamoDBLambdaStack, dynamodbLambdaStackName} from '../patterns/dynamodb-stream-lambda/stack';
import {DynamodbToS3Stack, dynamodbToS3StackName} from '../patterns/dynamodb-to-s3-zero-etl/stack';
import {S3TablesStack, s3TablesStackName} from '../patterns/s3-tables-bucket/stack';
import {S3TablesLakeFormationSetupStack, s3TablesLakeFormationSetupStackName} from '../patterns/s3-tables-bucket/setup_stack';
import {ElastiCacheValkeyStack, elasticacheValkeyActivePassiveStackName} from '../patterns/elasticache-valkey-active-passive/stack';
import {ElastiCacheValkeyClusterStack, elasticacheValkeyClusterStackName} from '../patterns/elasticache-valkey-cluster/stack';
import {ElastiCacheValkeyClusterAppStack, elasticacheValkeyClusterAppStackName} from '../patterns/elasticache-valkey-cluster/app_stack';
import {ElastiCacheValkeyServerlessStack, elasticacheValkeyServerlessStackName} from '../patterns/elasticache-valkey-serverless/stack';
import {ElastiCacheValkeyServerlessAppStack, elasticacheValkeyServerlessAppStackName} from '../patterns/elasticache-valkey-serverless/app_stack';
import {VpcSubnetsStack, vpcSubnetsStackName} from '../patterns/vpc-subnets/stack';
import {SsmBastionStack, ssmBastionStackName} from '../patterns/ssm-bastion/stack';
import {ElasticContainerRegistryStack, elasticContainerRegistryStackName} from '../patterns/containers/elastic-container-registry/stack';
import {EcsClusterStack, ecsClusterStackName} from '../patterns/containers/ecs-fargate-apigw/stack_ecs_cluster';
import {EcsFargateComputeStack, ecsFargateComputeStackName} from '../patterns/containers/ecs-fargate-apigw/stack_compute';
import {EcsFargateNetworkingStack, ecsFargateNetworkingStackName} from '../patterns/containers/ecs-fargate-apigw/stack_networking';
import {EcsFargateAlbNetworkingStack, ecsFargateAlbNetworkingStackName} from '../patterns/containers/ecs-fargate-alb/stack_networking';
import {EcsFargateAlbComputeStack, ecsFargateAlbComputeStackName} from '../patterns/containers/ecs-fargate-alb/stack_compute';
import {LambdaContainerStack, lambdaContainerStackName} from '../patterns/containers/lambda-container/stack';
import {OpenSearchServerlessStack, opensearchServerlessStackName} from '../patterns/opensearch-serverless/stack';
import {OpenSearchServerlessAppStack, opensearchServerlessAppStackName} from '../patterns/opensearch-serverless/app_stack';
import {OpenSearchProvisionedStack, opensearchProvisionedStackName} from '../patterns/opensearch-provisioned/stack';
import {OpenSearchProvisionedAppStack, opensearchProvisionedAppStackName} from '../patterns/opensearch-provisioned/app_stack';

const app = new cdk.App();

new S3EventsNotification(app, s3EventsNotificationStackName, {
  /* If you don't specify 'env', this stack will be environment-agnostic.
   * Account/Region-dependent features and context lookups will not work,
   * but a single synthesized template can be deployed anywhere. */

  /* Uncomment the next line to specialize this stack for the AWS Account
   * and Region that are implied by the current CLI configuration. */
  env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},

  /* Uncomment the next line if you know exactly what Account and Region you
   * want to deploy the stack to. */
  // env: { account: '123456789012', region: 'us-east-1' },

  /* For more information, see https://docs.aws.amazon.com/cdk/latest/guide/environments.html */
});

new S3CrossRegionReplicationStackStep1(app, 'S3CrossRegionReplicationStackStep1', {
  // destination bucket is set to Ireland
  env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: 'eu-west-1'},
})
new S3CrossRegionReplicationStackStep2(app, 'S3CrossRegionReplicationStackStep2', {
  env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},
})

new S3PolishedConfigurationStack(app, 'S3PolishedConfigurationStack', {
  env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},
})

new S3StaticWebsiteCloudfrontStack(app, s3StaticWebsiteCloudfrontStackName, {
  env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},
})

new S3LambdaRekognitionDynamodbStack(app, s3LambdaRekognitionDynamodbStackName, {
  env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},
})

new S3BehindSftpStack(app, s3BehindSftpStackName, {
  env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},
})

new DynamodbGlobalDatabaseStack(app, dynamodbGlobalDatabaseStackName, {
  env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},
})

new S3VectorsStack(app, s3VectorsStackName, {
  env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},
})

new DynamoDBLambdaStack(app, dynamodbLambdaStackName, {
  env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},
})

new DynamodbToS3Stack(app, dynamodbToS3StackName, {
  env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},
})

new S3TablesLakeFormationSetupStack(app, s3TablesLakeFormationSetupStackName, {
  env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},
})

new S3TablesStack(app, s3TablesStackName, {
  env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},
})

const vpcStack = new VpcSubnetsStack(app, vpcSubnetsStackName, {
  env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},
  natProviderType: 'self-managed',
});

const bastionStack = new SsmBastionStack(app, ssmBastionStackName, {
  env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},
  vpc: vpcStack.vpc,
});

new ElastiCacheValkeyStack(app, elasticacheValkeyActivePassiveStackName, {
  env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},
  vpc: vpcStack.vpc,
  bastionSG: bastionStack.bastionSG,
});

const clusterStack = new ElastiCacheValkeyClusterStack(app, elasticacheValkeyClusterStackName, {
  env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},
  vpc: vpcStack.vpc,
});

new ElastiCacheValkeyClusterAppStack(app, elasticacheValkeyClusterAppStackName, {
  env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},
  vpc: vpcStack.vpc,
  cacheSG: clusterStack.cacheSG,
  appUserSecret: clusterStack.appUserSecret,
});

const serverlessStack = new ElastiCacheValkeyServerlessStack(app, elasticacheValkeyServerlessStackName, {
  env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},
  vpc: vpcStack.vpc,
});

new ElastiCacheValkeyServerlessAppStack(app, elasticacheValkeyServerlessAppStackName, {
  env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},
  vpc: vpcStack.vpc,
  cacheSG: serverlessStack.cacheSG,
  appUserSecret: serverlessStack.appUserSecret,
});

new ElasticContainerRegistryStack(app, elasticContainerRegistryStackName, {
  env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},
});

const ecsClusterStack = new EcsClusterStack(app, ecsClusterStackName, {
  env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},
  vpc: vpcStack.vpc,
});

const ecsComputeStack = new EcsFargateComputeStack(app, ecsFargateComputeStackName, {
  env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},
  vpc: vpcStack.vpc,
  cluster: ecsClusterStack.cluster,
  namespace: ecsClusterStack.namespace,
});

new EcsFargateNetworkingStack(app, ecsFargateNetworkingStackName, {
  env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},
  vpc: vpcStack.vpc,
  cloudMapService: ecsComputeStack.cloudMapService,
  taskSg: ecsComputeStack.taskSg,
});

const ecsFargateAlbNetworkingStack = new EcsFargateAlbNetworkingStack(app, ecsFargateAlbNetworkingStackName, {
  env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},
  vpc: vpcStack.vpc,
});

new EcsFargateAlbComputeStack(app, ecsFargateAlbComputeStackName, {
  env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},
  vpc: vpcStack.vpc,
  cluster: ecsClusterStack.cluster,
  listener: ecsFargateAlbNetworkingStack.listener,
});

new LambdaContainerStack(app, lambdaContainerStackName, {
  env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},
});

const ossStack = new OpenSearchServerlessStack(app, opensearchServerlessStackName, {
  env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},
  vpc: vpcStack.vpc,
});

new OpenSearchServerlessAppStack(app, opensearchServerlessAppStackName, {
  env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},
  bastionSG: bastionStack.bastionSG,
  vpcEndpointSG: ossStack.vpcEndpointSG,
});

const ospStack = new OpenSearchProvisionedStack(app, opensearchProvisionedStackName, {
  env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},
  vpc: vpcStack.vpc,
});

new OpenSearchProvisionedAppStack(app, opensearchProvisionedAppStackName, {
  env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},
  bastionSG: bastionStack.bastionSG,
  domainSG: ospStack.domainSG,
});

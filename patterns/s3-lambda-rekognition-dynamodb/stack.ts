import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3Notifications from 'aws-cdk-lib/aws-s3-notifications';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambdaDestinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as path from 'path';

export const s3LambdaRekognitionDynamodbStackName = 'S3LambdaRekognitionDynamodb';

// S3LambdaRekognitionDynamodbStack implements an image analysis pipeline:
// upload image to S3 → Lambda → Rekognition detectLabels → DynamoDB
export class S3LambdaRekognitionDynamodbStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Private S3 bucket for image uploads. The bucket name includes account and
    // region to ensure global uniqueness (S3 bucket names are globally unique).
    const bucket = new s3.Bucket(this, 'ImageBucket', {
      bucketName: `image-rekognition-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      // !! Change the following in production.
      // This deletes the bucket when the stack is deleted (for easy cleanup).
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // DynamoDB table storing Rekognition results, keyed by S3 object key.
    // Schema: imageKey (PK) | bucket | labels (list of {name, confidence}) | processedAt
    //
    // PAY_PER_REQUEST (on-demand) billing avoids provisioned capacity costs
    // for sporadic workloads. For high-throughput production use, PROVISIONED
    // with auto-scaling is more cost-effective.
    const table = new dynamodb.TableV2(this, 'LabelsTable', {
      tableName: 'image-rekognition-labels',
      partitionKey: { name: 'imageKey', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // NodejsFunction bundles handler.ts using esbuild at synth time, producing
    // a single minified JS file. This is the recommended approach for TypeScript
    // Lambdas — no separate build step, no zip file management.
    //
    // Alternative: lambda.Function + Code.fromAsset() with a pre-compiled JS file.
    // That avoids the esbuild dependency but requires a separate tsc build step
    // and loses tree-shaking.
    //
    // externalModules: ['@aws-sdk/*'] excludes the AWS SDK from the bundle.
    // The Lambda Node 20 runtime ships AWS SDK v3, so bundling it would only
    // increase the zip size and cold start time with no benefit.
    const imageProcessor = new lambdaNodejs.NodejsFunction(this, 'ImageProcessor', {
      functionName: 'image-rekognition-processor',
      entry: path.join(__dirname, 'handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      // Rekognition p99 latency is typically under 3s, but allow headroom for
      // large images or cold starts.
      timeout: cdk.Duration.seconds(30),
      environment: { TABLE_NAME: table.tableName },
      bundling: { externalModules: ['@aws-sdk/*'] },
    });

    // IAM permissions — least privilege:
    // - S3 read: Rekognition accesses the image directly from S3 using the
    //   Lambda's execution role, so the role needs GetObject on the bucket.
    // - DynamoDB write: PutItem only (grantWriteData excludes read operations).
    // - Rekognition: does not support resource-level permissions, so '*' is required.
    bucket.grantRead(imageProcessor);
    table.grantWriteData(imageProcessor);
    imageProcessor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['rekognition:DetectLabels'],
        resources: ['*'],
      }),
    );

    // Async invocation failure destination. S3 event notifications always invoke
    // Lambda asynchronously — Lambda retries twice on failure, then drops the event
    // silently unless a destination is configured. This SQS queue captures events
    // that failed all 3 attempts, enabling investigation and reprocessing.
    const dlq = new sqs.Queue(this, 'FailedProcessingQueue', {
      queueName: 'image-rekognition-dlq',
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    imageProcessor.configureAsyncInvoke({
      retryAttempts: 2,
      onFailure: new lambdaDestinations.SqsDestination(dlq),
    });

    // S3 event notification: invoke Lambda whenever an object is created.
    // One notification configuration is added per suffix because S3 only allows
    // a single suffix filter per notification config.
    //
    // Alternative: EventBridge — more flexible filtering and fan-out to multiple
    // consumers, but adds latency (~seconds vs ~milliseconds) and cost for a
    // single-consumer use case like this one.
    for (const suffix of ['.jpg', '.jpeg', '.png']) {
      bucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3Notifications.LambdaDestination(imageProcessor), {
        suffix,
      });
    }

    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'FunctionName', { value: imageProcessor.functionName });
    new cdk.CfnOutput(this, 'DLQUrl', { value: dlq.queueUrl });
  }
}

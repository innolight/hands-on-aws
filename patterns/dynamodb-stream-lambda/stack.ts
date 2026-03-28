import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as path from 'path';

export const dynamodbLambdaStackName = 'DynamoDBLambda';

// Change Data Capture (CDC) pattern:
// write to DynamoDB → DynamoDB Streams → Lambda → Process Side Effects
export class DynamoDBLambdaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1. DynamoDB Table with Streams enabled.
    // Streams capture every modification (Insert, Update, Delete) as a record.
    //
    // StreamViewType.NEW_AND_OLD_IMAGES:
    // Both the item before and after the change are sent to the stream.
    // This allows the Lambda to compare "diffs" (e.g., status changed from PENDING to PAID).
    const table = new dynamodb.TableV2(this, 'OrdersTable', {
      tableName: 'orders-cdc-demo',
      partitionKey: { name: 'orderId', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      dynamoStream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      // !! Change the following in production.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // 2. Dead Letter Queue (DLQ) for failed stream records.
    // Because DynamoDB Streams are ordered, a failing record "blocks the line" (Head-of-Line Blocking).
    // If a record cannot be processed after X retries, it is sent here to "unblock" the stream.
    const dlq = new sqs.Queue(this, 'StreamDeadLetterQueue', {
      queueName: 'orders-cdc-dlq',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // 3. Lambda Function to process the stream records.
    const processor = new lambdaNodejs.NodejsFunction(this, 'StreamProcessor', {
      functionName: 'orders-stream-processor',
      entry: path.join(__dirname, 'handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      environment: { TABLE_NAME: table.tableName },
      bundling: { externalModules: ['@aws-sdk/*'] },
    });

    // 4. DynamoDB Event Source Mapping (The "Connector").
    // This connects the Stream to the Lambda.
    //
    // Best Practices for Resilience:
    // - bisectBatchOnFunctionError: If a batch fails, split it in half and retry.
    //   This isolates "poison pill" records quickly.
    // - retryAttempts: Limits how many times to retry before giving up and sending to DLQ.
    // - onFailure: Destination for records that failed all retries.
    processor.addEventSource(
      new lambdaEventSources.DynamoEventSource(table, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 5, // Small batch for demo purposes (max is 10,000)
        bisectBatchOnError: true,
        retryAttempts: 3,
        onFailure: new lambdaEventSources.SqsDlq(dlq),
      }),
    );

    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'FunctionName', { value: processor.functionName });
    new cdk.CfnOutput(this, 'DLQUrl', { value: dlq.queueUrl });
  }
}

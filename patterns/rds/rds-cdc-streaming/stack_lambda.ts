import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as path from 'path';

export const rdsCdcStreamingLambdaStackName = 'RdsCdcStreamingLambda';

interface RdsCdcStreamingLambdaStackProps extends cdk.StackProps {
  stream: kinesis.Stream;
}

// Lambda consumes DMS CDC events from Kinesis → deduplicates in DynamoDB → logs processed events
export class RdsCdcStreamingLambdaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RdsCdcStreamingLambdaStackProps) {
    super(scope, id, props);

    // DynamoDB dedup table: prevents duplicate processing on Kinesis at-least-once delivery.
    // PK is the eventId (schema.table.pk.op.txn_id). TTL cleans up records after 24 hours.
    const dedupTable = new dynamodb.TableV2(this, 'DedupTable', {
      tableName: 'rds-cdc-dedup',
      partitionKey: { name: 'eventId', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: 'expiresAt',
      // !! Change the following in production.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // DLQ for CDC records that exhaust all retries.
    // Kinesis streams are ordered per shard — a permanently failing record blocks all subsequent
    // records in that shard. The DLQ unblocks the shard and preserves the failed record for inspection.
    const dlq = new sqs.Queue(this, 'CdcDlq', {
      queueName: 'rds-cdc-dlq',
      // Retain 14 days for post-mortem analysis of failed CDC events.
      retentionPeriod: cdk.Duration.days(14),
      // !! Change the following in production.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const processor = new lambdaNodejs.NodejsFunction(this, 'CdcProcessor', {
      functionName: 'rds-cdc-processor',
      entry: path.join(__dirname, 'handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      environment: { DEDUP_TABLE_NAME: dedupTable.tableName },
      // externalModules: Lambda Node 20 runtime ships SDK v3; bundling it adds ~3 MB with no benefit.
      bundling: { externalModules: ['@aws-sdk/*'] },
    });

    // Grant only the permissions the Lambda actually needs — not full DynamoDB access.
    dedupTable.grantReadWriteData(processor);

    // Kinesis event source mapping.
    //
    // startingPosition: TRIM_HORIZON — processes from the oldest record in the stream.
    //   DMS writes the full-load snapshot to Kinesis before switching to CDC. Starting
    //   from TRIM_HORIZON ensures the Lambda sees all records, including the initial snapshot.
    //   Use LATEST only if you want to skip existing data and process future changes only.
    //
    // bisectBatchOnError: true — on Lambda error, splits the batch in half and retries each half.
    //   Isolates poison-pill records efficiently without exhausting the retry quota on the full batch.
    //
    // reportBatchItemFailures: true — Lambda returns { batchItemFailures: [...] } for partial success.
    //   Without this, any error retries the entire batch, re-processing records that already succeeded.
    //   For this pipeline: avoids duplicate DynamoDB writes and duplicate log entries on retry.
    //
    // retryAttempts: 3 — bounded retries. After 3 failures the record goes to the DLQ.
    //   The default (-1) retries until the record expires from the stream (24h here), which can
    //   block the shard for a long time on a persistent error (schema mismatch, permissions, etc.)
    processor.addEventSource(
      new lambdaEventSources.KinesisEventSource(props.stream, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 10,
        bisectBatchOnError: true,
        reportBatchItemFailures: true,
        retryAttempts: 3,
        onFailure: new lambdaEventSources.SqsDlq(dlq),
      }),
    );

    new cdk.CfnOutput(this, 'FunctionName', { value: processor.functionName });
    new cdk.CfnOutput(this, 'DLQUrl', { value: dlq.queueUrl });
    new cdk.CfnOutput(this, 'DedupTableName', { value: dedupTable.tableName });
  }
}

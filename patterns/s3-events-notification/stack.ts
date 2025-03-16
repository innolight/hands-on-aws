import * as cdk from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as s3Notifications from 'aws-cdk-lib/aws-s3-notifications';

export const s3EventsNotificationStackName = "S3EventsNotification";

// S3EventsNotification implement patterns: S3  --> events (created, removed) --> SNS --> SQS --> SQS (DLQ - Dead-Letter-Queue)
export class S3EventsNotification extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);


    // SQS DLQ for failed messages
    const sqsDlq = new sqs.Queue(this, 'SqsDlq', {
      queueName: `s3-events-notification-sqs-dlq`,
      retentionPeriod: cdk.Duration.days(14),
    });

    // SQS queue subscribed to SNS topic
    const sqsQueue = new sqs.Queue(this, 'Sqs', {
      queueName: `s3-events-notification-sqs`,
      visibilityTimeout: cdk.Duration.minutes(5),
      deadLetterQueue: {
        queue: sqsDlq,
        // after 4 failed processing, send message to DLQ
        maxReceiveCount: 4,
      },
    });

    // SNS topic for S3 events notification
    const snsTopic = new sns.Topic(this, 'Sns', {
      topicName: `s3-events-notification-sns`,
    });

    // SQS subscription to SNS
    snsTopic.addSubscription(
      new snsSubscriptions.SqsSubscription(sqsQueue, {
        // prevent message from being wrapped in SNS envelop
        rawMessageDelivery: true,
      })
    );


    // Create the S3 bucket with encryption enabled
    const bucket = new s3.Bucket(this, 'S3Bucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      bucketName: `s3-events-notification-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      //  !! Change the following in production.
      // This deletes the bucket when the stack is deleted (for easy cleanup).
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Send S3 Events Notification to the SNS Topic.
    bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3Notifications.SnsDestination(snsTopic), {
        // The trigger will only fire on files with the .txt extension.
        suffix: '.json'
      }
    );


    // Outputs
    new cdk.CfnOutput(this, 'S3BucketName', {value: bucket.bucketName});
    new cdk.CfnOutput(this, 'SNSTopicArn', {value: snsTopic.topicArn});
    new cdk.CfnOutput(this, 'SQSQueueUrl', {value: sqsQueue.queueUrl});
    new cdk.CfnOutput(this, 'SQSDLQUrl', {value: sqsDlq.queueUrl});
  }
}

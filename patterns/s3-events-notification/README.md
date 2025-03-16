# S3 Events Notification Pattern

Pattern Description:
- S3 Bucket to store objects
- SNS topic to receive [Events Notification](https://docs.aws.amazon.com/AmazonS3/latest/userguide/EventNotifications.html) from bucket
- SQS to subscribe to SNS topic
- DLQ SQS to store unprocessed SQS message

Notes:
- SQS queue can directly receive events notification from S3.
- SNS is used here as fan-out pattern to send messages to multiple SQS subscribers.
- _CDK quirk_: The output Cloudformation contains a lambda to apply bucket notification ([discussion](https://github.com/aws/aws-cdk/issues/9890))

Commands play with stack:
- `cdk deploy S3EventsNotification` to deploy the stack
- `ts-node patterns/s3-events-notification/demo_server.ts` to run example application with the following [endpoints](./demo_requests.http)
  - `POST /s3-file-uploads`: Upload json file to S3
  - `GET /sqs/s3-events`: Poll 1 events from the SQS queue
- `cdk destroy S3EventsNotification`: Destroy the stack to avoid unexpected cloud cost

Development guide:
- `cdk synth > patterns/s3-events-notification/cf.yaml`


# S3 Events Notification Pattern

Pattern Description:
- S3 Bucket to store objects
- Configure bucket to send events notification to SNS topic
- SQS subscribes to SNS topic
- SQS has another SQS as DLQ for unprocessed message

Commands play with stack:
- `cdk deploy S3EventsNotification` to deploy the stack
- `ts-node patterns/s3-events-notification/demo_server.ts` to run example application with the following endpoints
  - `POST /s3-file-uploads`: Upload json file to S3
  - `GET /sqs/s3-events`: Poll 1 events from the SQS queue
- `cdk destroy S3EventsNotification`: Destroy the stack to avoid unexpected cloud cost

Development guide:
- Run `cdk synth > patterns/s3-events-notification/cf.yaml` after you have updated the [stack.ts](./stack.ts) to
document the output Cloud Formation for study. 


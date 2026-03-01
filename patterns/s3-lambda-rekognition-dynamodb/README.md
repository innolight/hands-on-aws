# S3 → Lambda → Rekognition → DynamoDB

**Pattern Description**:
- S3 bucket receives image uploads (`.jpg`, `.jpeg`, `.png`)
- [S3 Event Notification](https://docs.aws.amazon.com/AmazonS3/latest/userguide/NotificationHowTo.html) triggers a Lambda function on each upload
- Lambda calls [Rekognition DetectLabels](https://docs.aws.amazon.com/rekognition/latest/dg/labels-detect-labels-image.html) to identify objects, scenes, and concepts in the image
- Results (labels with confidence scores) are stored in a [DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Introduction.html) table keyed by the S3 object key

**DynamoDB record**:

| Attribute | Type | Description |
|---|---|---|
| `imageKey` (PK) | String | S3 object key |
| `bucket` | String | S3 bucket name |
| `labels` | List | `{name, confidence}` pairs from Rekognition (max 10, min confidence 70%) |
| `processedAt` | String | ISO timestamp of analysis |

**Cost** (eu-central-1, ~1K images/month, 5 MB avg):

| Resource | Idle | ~1K images | Cost driver |
|---|---|---|---|
| Rekognition | $0.00 | ~$1.00 | $0.001/image (first 1M/month) |
| Lambda | $0.00 | ~$0.00 | Free tier covers 1K × ~3s × 128 MB easily |
| DynamoDB | $0.00 | ~$0.00 | $1.25/M WCU on-demand — 1K writes ≈ $0.00 |
| S3 storage | $0.00 | ~$0.12 | $0.0245/GB — 5 GB for 1K images |
| S3 requests | $0.00 | ~$0.01 | $0.0054/1K PUTs |
| CloudWatch Logs | $0.00 | ~$0.00 | Minimal Lambda log output |

**Notes**:
- Rekognition operates on the S3 object directly (no data transfer through Lambda); the Lambda role needs `s3:GetObject` on the bucket so Rekognition can access it
- Image size limit: 15 MB (Rekognition constraint)
- Rekognition is not available in all regions; `eu-central-1` is supported
- **Async Lambda invocation & reliability**: S3 event notifications always invoke Lambda [asynchronously](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async.html) — S3 receives a `202 Accepted` and does not wait for the function to complete. Lambda manages an internal event queue and handles retries:
  - On failure, Lambda retries **2 more times** (3 total attempts) with backoff delays (1 min, then 2 min)
  - `MaximumEventAge` (default 6h) — events waiting in the queue longer than this are discarded
  - Without a failure destination, events that exhaust all retries are **silently dropped**
  - This stack configures an [SQS dead-letter queue](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async.html#invocation-async-destinations) (`onFailure` destination) to capture failed events for investigation and reprocessing
  - The DLQ can trigger downstream automation — e.g. an SNS topic for email alerts, or another Lambda that retries/reprocesses failed images
  - The `onFailure` destination wraps the original event in an [envelope](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async.html#invocation-async-destinations) containing error context (`requestContext`, `responseContext`); to retrigger the Lambda, extract the original S3 event from `requestPayload`
  - The handler is naturally **idempotent** — `PutItem` with the same `imageKey` overwrites the previous record, so retries are safe
  - This differs from *synchronous* invocation (API Gateway, SDK `Invoke`) where the caller receives errors directly and is responsible for retries
- **Alternative: S3 → SQS → Lambda (synchronous invocation model)**: instead of S3 invoking Lambda directly (async), S3 sends the event to an [SQS queue](https://docs.aws.amazon.com/AmazonS3/latest/userguide/NotificationHowTo.html), and Lambda [polls the queue](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html) via an event source mapping. This changes the invocation model from async to **synchronous** (Lambda's SQS poller calls `Invoke` synchronously) and improves error handling:
  - Failed messages return to the queue automatically and are retried based on the queue's `VisibilityTimeout` and `maxReceiveCount` — more control than Lambda's built-in 2-retry async behavior
  - After `maxReceiveCount` attempts, SQS moves the message to a [dead-letter queue](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html) natively — no need for Lambda's `onFailure` destination
  - `batchSize` and `maxBatchingWindow` let you tune throughput vs. cost (process multiple images per invocation)
  - SQS provides backpressure: if Lambda is throttled or slow, messages wait in the queue instead of being retried by Lambda's async retry mechanism
  - Tradeoff: adds SQS cost (~$0.40/M requests) and a slight delay (SQS long-polling interval, typically ≤20s), but both are negligible at low volumes

**Commands to play with stack**:
- Deploy: `npx cdk deploy S3LambdaRekognitionDynamodb`
- Upload a test image:
  ```bash
  BUCKET=$(aws cloudformation describe-stacks --stack-name S3LambdaRekognitionDynamodb \
    --query "Stacks[0].Outputs[?OutputKey=='BucketName'].OutputValue" --output text)
  aws s3 cp patterns/s3-lambda-rekognition-dynamodb/image.png s3://$BUCKET/test-image.jpg
  ```
- Read results (wait ~5s after upload):
  ```bash
  aws dynamodb get-item \
    --table-name image-rekognition-labels \
    --key '{"imageKey": {"S": "test-image.jpg"}}'
  ```
- Check Lambda logs: `aws logs tail /aws/lambda/image-rekognition-processor --since 5m`
- Check DLQ for failed events: `aws sqs receive-message --queue-url $(aws cloudformation describe-stacks --stack-name S3LambdaRekognitionDynamodb --query "Stacks[0].Outputs[?OutputKey=='DLQUrl'].OutputValue" --output text)`
- Destroy stack: `npx cdk destroy S3LambdaRekognitionDynamodb`
- Capture the CloudFormation yaml: `npx cdk synth S3LambdaRekognitionDynamodb > patterns/s3-lambda-rekognition-dynamodb/cloud_formation.yaml`

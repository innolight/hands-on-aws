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
- `removalPolicy: DESTROY` on all resources — not for production
- Rekognition operates on the S3 object directly (no data transfer through Lambda); the Lambda role needs `s3:GetObject` on the bucket so Rekognition can access it
- Image size limit: 15 MB (Rekognition constraint)
- Rekognition is not available in all regions; `eu-central-1` is supported

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
- Destroy stack: `npx cdk destroy S3LambdaRekognitionDynamodb`
- Capture the CloudFormation yaml: `npx cdk synth S3LambdaRekognitionDynamodb > patterns/s3-lambda-rekognition-dynamodb/cloud_formation.yaml`

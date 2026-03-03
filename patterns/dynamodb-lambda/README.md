# DynamoDB Streams to Lambda

This pattern implements Change Data Capture (CDC) using DynamoDB Streams. When an item in the DynamoDB table is created, updated, or deleted, a record is written to a stream, which triggers a Lambda function asynchronously.

- **DynamoDB Table** — configured with `StreamViewType.NEW_AND_OLD_IMAGES` to capture both pre- and post-modification states of the data.
- **DynamoDB Stream** — a time-ordered sequence of item-level changes in the table. Records are available for 24 hours.
- **AWS Lambda** — polls the stream and processes batches of change records.
- **Dead Letter Queue (SQS)** — captures records that failed all retry attempts to prevent head-of-line blocking.

## Cost

| Resource | Idle | ~1M unit/month | Cost driver |
| :--- | :--- | :--- | :--- |
| DynamoDB | $0.00 (On-Demand) | $1.25 | Write Request Units (WRU) |
| DynamoDB Streams | $0.00 | $0.02 | Stream Read Request Units |
| AWS Lambda | $0.00 | $1.86 | Invocations and duration |
| SQS (DLQ) | $0.00 | $0.00 | Failure volume |

**Dominant cost driver**: For this pattern at 1M units, **AWS Lambda** (invocations and duration) and **DynamoDB WRUs** are the primary costs (~$3.13 total).

## Notes

### Resilience Best Practices
- **Bisect Batch on Function Error**: If a batch of records fails (e.g., due to a "poison pill" record), Lambda automatically splits the batch into two smaller batches and retries them separately. This quickly isolates the problematic record.
- **Dead Letter Queue (DLQ)**: Since streams are ordered, a single failure can block the entire shard (Head-of-Line Blocking). We use an SQS DLQ to "drain" failed records after 3 retries, allowing the rest of the stream to continue.
- **Stream Retention**: Records only live for **24 hours**. If your consumer is down for longer than that, you will lose data. For longer retention, consider Kinesis Data Streams.
- **Idempotency**: Lambda may process the same record more than once (e.g., due to a timeout or retry). Always ensure your processing logic is idempotent (e.g., check if an email was already sent for a specific OrderID + EventID).

### Alternatives
- **Direct Lambda Call**: Call Lambda directly from your application code after the DB write. Simple, but risks data inconsistency if the DB write succeeds but the Lambda call fails.
- **Kinesis Data Streams**: Supports multiple consumers per stream and longer retention (up to 365 days), but is more expensive and complex than DynamoDB Streams.
- **EventBridge Pipes**: A more modern way to connect Streams to targets without writing glue code.

## Commands to play with stack

1. **Deploy the stack**:
   ```bash
   npx cdk deploy DynamoDBLambda
   ```

2. **Start the demo server**:
   ```bash
   # In a separate terminal
   npx ts-node patterns/dynamodb-lambda/demo_server.ts
   ```

3. **Create an order (INSERT event)**:
   ```bash
   curl -X POST http://localhost:3000/orders -H "Content-Type: application/json" -d '{"orderId": "order-123", "amount": 50}'
   ```

4. **Pay the order (MODIFY event)**:
   ```bash
   curl -X PATCH http://localhost:3000/orders/order-123/pay
   ```

5. **Trigger a failure (Test DLQ/Bisecting)**:
   ```bash
   curl -X POST http://localhost:3000/orders/fail
   ```

6. **Observe Logs**:
   - Check the Lambda logs in CloudWatch to see the "Old Image" and "New Image" being processed.
   - For the failure trigger, you will see the Lambda retrying and then eventually the record landing in the SQS DLQ.

7. **Clean up**:
   ```bash
   npx cdk destroy DynamoDBLambda
   ```

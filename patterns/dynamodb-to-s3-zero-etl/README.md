# dynamodb-to-s3 — DynamoDB Zero-ETL to S3 Tables (Iceberg)

## [WIP] Pattern Description

**Note: Work in Progress. solution is not working as expected yet**

```
DynamoDB Table (PITR enabled)
  │  Glue Zero-ETL Integration
  │  (initial snapshot + streaming CDC, ~15 min latency)
  ▼
Glue Database → S3 Table Bucket (Iceberg)
  │
  ▼
Athena WorkGroup (engine v3)
  │  query results
  ▼
S3 Bucket (results)
```

- Write order items to [Amazon DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Introduction.html) (TableV2, on-demand, PITR enabled)
- [AWS Glue Zero-ETL Integration](https://docs.aws.amazon.com/glue/latest/dg/zero-etl-using.html) continuously replicates changes to [Amazon S3 Tables](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-what-is.html)
- The integration targets an **AWS Glue Data Catalog Database**, which is configured with a `locationUri` pointing to an **S3 Table Bucket**
- S3 Tables stores data as [Apache Iceberg](https://iceberg.apache.org/) tables — a columnar open table format with schema evolution, time travel, and compaction
- Query replicated data with [Amazon Athena](https://docs.aws.amazon.com/athena/latest/ug/what-is.html) (engine v3, native Iceberg support) — no ETL pipelines to maintain

Data flow: `DynamoDB write → Zero-ETL (initial PITR snapshot + streaming CDC) → Glue Database → S3 Table Bucket (Iceberg) → Athena query`

### Code Structure

- [stack.ts](./stack.ts) — CDK stack defining DynamoDB Table (PITR enabled), Glue Zero-ETL Integration, S3 Table Bucket, and Athena WorkGroup
- [demo_server.ts](./demo_server.ts) — Express server to interact with the pattern (seed data, poll integration status, run Athena queries)
- [cloud_formation.yaml](./cloud_formation.yaml) — Synthesized CloudFormation template

## Cost

Region: `eu-central-1` | Workload: ~10K items/month

| Resource             | Idle            | ~10K items/month | Cost driver                |
| -------------------- | --------------- | ---------------- | -------------------------- |
| DynamoDB (on-demand) | $0              | ~$0.01           | Write RCUs                 |
| DynamoDB PITR        | $0.20/GB/month  | <$0.01           | Storage                    |
| Glue Zero-ETL        | $0              | ~$0.10           | DPU-hours for replication  |
| S3 Tables            | $0.023/GB/month | <$0.01           | Storage + Iceberg overhead |
| Athena               | $0              | ~$0.01           | $5/TB scanned              |
| **Total**            | ~$0.20          | ~$0.20           | **DynamoDB PITR**          |

Dominant cost driver at low volume: DynamoDB PITR ($0.20/GB-month). At scale, Glue DPU-hours dominate.

## Notes

**Zero-ETL mechanics**

- Glue first exports the full table via DynamoDB PITR (point-in-time recovery), then streams CDC (change data capture) from DynamoDB Streams. This is why PITR is mandatory.
- **Target ARN**: The integration `targetArn` must be a **Glue Data Catalog database ARN**, not the S3 Tables bucket ARN directly. The Glue database is created with its `locationUri` pointing to the S3 Table Bucket.
- Estimated latency from write to Athena-queryable: ~15 minutes for new data; initial sync may take longer for large tables.
- Glue creates an Iceberg namespace and table inside the S3 Table Bucket automatically — you don't define the Iceberg schema manually.

**S3 Tables vs regular S3**

- S3 Tables are a separate resource type (`AWS::S3Tables::TableBucket`) — not accessible via `s3://` paths or the regular S3 console. Access is through the Iceberg REST Catalog endpoint.
- Iceberg tables support schema evolution (add/remove columns without rewrite), time travel (`FOR SYSTEM_TIME AS OF`), and automatic compaction.

**Dual resource policy requirement**

- Zero-ETL authorization requires two resource policies: one on the DynamoDB table (allowing Glue to export) and one on the Glue catalog (allowing DynamoDB service to push into it with `EnableHybrid: TRUE`).
- The Glue catalog resource policy must authorize the specific **Glue Database** that acts as the integration destination.
- CDK has no L1/L2 for either policy — both are created via `AwsCustomResource` SDK calls.

**Athena database and table names**

- Glue creates the Iceberg database and table inside the S3 Table Bucket after the integration activates. Discover the exact names in the AWS Glue console → Databases, or via `aws glue get-databases`.
- In this pattern, the explicit database created is named `zero_etl_demo_db`.

**Production considerations**

- Remove `removalPolicy: DESTROY` from the DynamoDB table — data loss on stack delete.
- Scope IAM permissions for the Glue target role more tightly (restrict s3tables actions to specific tables, not `*`).
- Enable KMS encryption on both the DynamoDB table and the Glue integration for data at rest.
- Consider CloudWatch alarms on the `AWS/Glue/ZeroETL` namespace for replication lag.

**Alternative: DynamoDB Streams → Kinesis → Firehose → S3 (Parquet)**

- Zero-ETL: fully managed, no Lambda/Glue jobs, Iceberg format, ~15 min latency, limited to DynamoDB → S3 Tables
- Streams/Kinesis/Firehose: more configurable, custom transformations possible, Parquet on regular S3, more moving parts to manage

## Commands to play with stack

**Deploy**

```bash
npx cdk deploy DynamodbToS3
```

**Run demo server**

```bash
AWS_REGION=eu-central-1 npx ts-node patterns/dynamodb-to-s3/demo_server.ts
```

**Write a single item**

```bash
curl -X POST http://localhost:3000/items \
  -H "Content-Type: application/json" \
  -d '{"orderId": "001", "itemId": "A1", "product": "Widget A", "quantity": 2, "price": 19.99, "status": "pending"}'
```

**Seed 25 items**

```bash
curl -X POST http://localhost:3000/items/batch
```

**Check integration status (wait for ACTIVE before querying)**

```bash
aws glue list-integrations --source-arn $(aws dynamodb describe-table \
  --table-name zero-etl-demo --query 'Table.TableArn' --output text) \
  --query 'Integrations[0].{Status:Status,Name:IntegrationName}'
```

**Discover Glue database and table names created by Zero-ETL**

```bash
aws glue get-databases --query 'DatabaseList[*].Name'
```

**Start an Athena query (replace DB and TABLE with discovered names)**

```bash
curl -X POST http://localhost:3000/query \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT status, COUNT(*) as cnt FROM \"zero_etl_demo_db\".\"<TABLE>\" GROUP BY status"}'
# returns: { "queryExecutionId": "..." }
```

**Poll query results**

```bash
curl http://localhost:3000/query/<queryExecutionId>
```

**Destroy**

```bash
npx cdk destroy DynamodbToS3
```

**Synthesize CloudFormation**

```bash
npx cdk synth DynamodbToS3 2>/dev/null > patterns/dynamodb-to-s3/cloud_formation.yaml
```

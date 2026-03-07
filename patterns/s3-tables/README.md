# s3-tables — S3 Tables (Iceberg) for Analytics

## Pattern Description

- Create an [Amazon S3 Table Bucket](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-what-is.html) with a namespace and [Apache Iceberg](https://iceberg.apache.org/) sales table
- Load sample sales data via [Amazon Athena](https://docs.aws.amazon.com/athena/latest/ug/what-is.html) `INSERT INTO` — full DML supported on S3 Tables without ETL pipelines
- Run analytics queries (aggregations, group-by) via Athena engine v3 with native Iceberg column pruning
- Demonstrate [Iceberg time travel](https://iceberg.apache.org/docs/latest/spark-queries/#time-travel) — query the table's state at a past snapshot with `FOR SYSTEM_TIME AS OF`

Data flow: `Athena INSERT INTO → S3 Table Bucket (Iceberg) → Athena SELECT`

## Cost

Region: `eu-central-1` | Workload: ~1 GB stored, ~100 queries/month

| Resource | Idle | ~100 queries/month | Cost driver |
|----------|------|--------------------|-------------|
| S3 Tables storage | $0.023/GB/month | ~$0.02 | Data volume |
| S3 Tables object monitoring | $0 | ~$0.025/1K objects | Object count |
| S3 Tables compaction | $0 | ~$0.005/GB | Data churn |
| Athena queries | $0 | ~$0.05 | $5/TB scanned |
| S3 (results bucket) | $0 | <$0.01 | Negligible |
| **Total** | ~$0 | ~$0.10 | **Athena scans** |

Dominant cost driver: Athena ($5/TB scanned). Iceberg column and partition pruning reduces scanned bytes. Storage is ~15% more expensive than standard S3 ($0.023 vs $0.023/GB in Frankfurt) but includes automatic maintenance.

## Notes

**S3 Tables vs regular S3 for Iceberg**
- S3 Tables manages compaction, snapshot expiry, and orphan file removal automatically — no Glue jobs or custom maintenance scripts needed
- Regular S3 + Iceberg (via Glue Data Catalog + Glue ETL) offers more flexibility (custom file formats, Hudi/Delta) but requires manual maintenance configuration
- S3 Tables storage costs slightly more than standard S3 but removes operational burden for Iceberg maintenance

**Catalog registration is a one-time account/region setup**
- Athena queries S3 Tables via a `s3tablescatalog` federated catalog in Glue. The `S3TablesLakeFormationSetup` stack automates this: IAM role with specific `s3tables:` data access permissions, Lake Formation registration, and Glue federated catalog.
- This is account/region-level, not per-bucket. Deploy once — but each deployed table bucket also needs per-database/table Lake Formation grants. The `S3Tables` stack handles this automatically via its `LakeFormationGrants` resource on deploy.
- Skipping the setup stack causes Athena to return `Table not found` errors; skipping the per-bucket grants causes `Principal does not have any privilege on specified resource`.

**Entity relationships**

```
AWS Account
│
├──[1:1]──► Lake Formation
│               │
│               ├──[1:N]──► Data Lake Location ──[N:1]──► IAM Role
│               │                                         (LF assumes this role to access S3 Tables)
│               │
│               └──[1:N]──► LF Sub-catalog  (s3tablescatalog/<bucket-name>)
│                               │             └── auto-created [1:1] per S3 Table Bucket (see below)
│                               │
│                               └──[1:N]──► Permission Grant
│                                               ├──[N:1]──► Principal  (e.g. IAM_ALLOWED_PRINCIPALS)
│                                               └──[N:1]──► Resource   (Database or Table)
│
├──[1:N]──► S3 Table Bucket ──────────────────── auto-creates LF Sub-catalog above [1:1]
│               │
│               └──[1:N]──► Namespace  (= LF Database)
│                               └──[1:N]──► Table  (Iceberg format)
│
└──[1:N]──► Athena WorkGroup
                └──[1:1]──► Results Bucket  (standard S3)
```

**Lake Formation (LF) permission hierarchy**
- Catalog-level LF grants (e.g. `IAM_ALLOWED_PRINCIPALS` ALL on `s3tablescatalog`) do **not** cascade to database/table data access in S3 Tables.
- Grants must target the bucket-specific sub-catalog: `s3tablescatalog/<bucket-name>` — not the parent `s3tablescatalog`.
- The `S3Tables` stack's `LakeFormationGrants` resource does this automatically at deploy time.

**Iceberg time travel**
- Every Athena write (`INSERT INTO`, `UPDATE`, `DELETE`) creates an Iceberg snapshot. S3 Tables retains snapshots per the table's maintenance config (default: 5 days).
- `FOR SYSTEM_TIME AS OF TIMESTAMP '<ts>'` reads the Iceberg manifest at that snapshot — no separate backup or export needed.
- Time travel queries are read-only and scan only the files referenced by that snapshot.

**Alternative: Athena CREATE TABLE instead of CfnTable schema**
- `CfnTable` with `icebergMetadata`: table exists at deploy time, schema is immutable via CDK (use `ALTER TABLE` for changes)
- Athena DDL: flexible types (e.g. `DATE` instead of `STRING`), schema changes via SQL, but requires a manual `CREATE TABLE` step after deploy before the demo server starts

**Production considerations**
- Remove `removalPolicy: DESTROY` and `autoDeleteObjects: true` from the results bucket — query history is lost on stack delete
- Enable KMS encryption on the table bucket (`encryptionConfiguration` on `CfnTableBucket`)
- Use Lake Formation fine-grained access control to scope Athena query permissions to specific namespaces/tables

## Commands to Play with Stack

**Deploy** (two stacks; setup stack is one-time per account/region)

Athena can't query S3 Tables directly — it needs a bridge through Lake Formation and the Glue Data Catalog. `S3TablesLakeFormationSetup` automates this: creates a custom IAM role with specific `s3tables:` data access permissions that Lake Formation assumes, registers S3 Tables as a Lake Formation data location, and creates a federated `s3tablescatalog` in Glue with `AllowFullTableExternalDataAccess`. Without it, Athena returns `Table not found` or `Unable to assume role`.

```bash
# 1. One-time setup (skip if already deployed in this account/region)
# Pass your permanent IAM user/role ARN — Lake Formation rejects temporary assumed-role credentials
LF_ADMIN=$(aws sts get-caller-identity --query Arn --output text)
npx cdk deploy S3TablesLakeFormationSetup -c lfAdmin=$LF_ADMIN

# 2. Deploy the table bucket, namespace, Iceberg table, and Athena workgroup
npx cdk deploy S3Tables

aws s3tables list-table-buckets # confirm table bucket created
```

**Start demo server**
```bash
AWS_REGION=eu-central-1 npx ts-node patterns/s3-tables/demo_server.ts
```

**Load sample sales data (note the `loadedAt` timestamp)**
```bash
curl -s -X POST http://localhost:3000/load | jq .
# { "inserted": 20, "loadedAt": "2024-01-15T10:30:00.000Z" }
```

**Run analytics queries**
```bash
# Revenue by product category
curl -s -X POST http://localhost:3000/query \
  -H "Content-Type: application/json" \
  -d '{"preset":"revenue_by_category"}' | jq .
# returns: { "queryExecutionId": "..." }

# Poll for results
curl -s http://localhost:3000/query/<queryExecutionId> | jq .

# Top products by revenue
curl -s -X POST http://localhost:3000/query \
  -H "Content-Type: application/json" \
  -d '{"preset":"top_products"}' | jq .

# Sales by day
curl -s -X POST http://localhost:3000/query \
  -H "Content-Type: application/json" \
  -d '{"preset":"daily_sales"}' | jq .

# Revenue by region and category
curl -s -X POST http://localhost:3000/query \
  -H "Content-Type: application/json" \
  -d '{"preset":"region_breakdown"}' | jq .
```

**Time travel demo**
```bash
# Note the loadedAt from the first load (e.g., "2024-01-15T10:30:00.000Z")
SNAPSHOT_TIME="<loadedAt from first load>"

# Load a second batch (adds 20 more rows — same rows, rows accumulate)
curl -s -X POST http://localhost:3000/load | jq .

# Query current state — shows both loads
curl -s -X POST http://localhost:3000/query \
  -H "Content-Type: application/json" \
  -d '{"preset":"daily_sales"}' | jq .

# Time travel — query state before the second load (shows only first batch)
curl -s -X POST http://localhost:3000/query \
  -H "Content-Type: application/json" \
  -d "{\"preset\":\"time_travel\",\"asOf\":\"${SNAPSHOT_TIME}\"}" | jq .
```

**Custom SQL**
```bash
curl -s -X POST http://localhost:3000/query \
  -H "Content-Type: application/json" \
  -d '{"sql":"SELECT * FROM sales LIMIT 5"}' | jq .
```

**Destroy**
```bash
npx cdk destroy S3Tables
LF_ADMIN=$(aws sts get-caller-identity --query Arn --output text)
npx cdk destroy S3TablesLakeFormationSetup  -c lfAdmin=$LF_ADMIN  # if no longer needed in this account/region
```

**Synthesize CloudFormation**
```bash
npx cdk synth S3Tables 2>/dev/null > patterns/s3-tables/cloud_formation.yaml
LF_ADMIN=$(aws sts get-caller-identity --query Arn --output text)
npx cdk synth S3TablesLakeFormationSetup -c lfAdmin=$LF_ADMIN 2>/dev/null > patterns/s3-tables/setup_cloud_formation.yaml
```

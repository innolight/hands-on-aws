# s3-vectors

## Pattern Description

```
CSV (1000 embeddings, 1536-dim)
  │  PutVectors (batches of 50)
  ▼
S3 Vector Bucket
  └── Vector Index (cosine, float32)
       │  QueryVectors (ANN search)
       ▼
     Nearest-neighbour results + metadata
```

Demonstrates [Amazon S3 Vectors](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors.html) — AWS's native vector storage built into S3 (GA December 2025). Uses 1,000 Amazon food reviews with pre-computed 1,536-dimensional [OpenAI ada-002](https://platform.openai.com/docs/guides/embeddings) embeddings. No live embedding API calls needed — embeddings ship with the dataset.

- One [VectorBucket](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors-vector-buckets.html) — top-level container, analogous to an S3 bucket
- One [VectorIndex](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors-indexes.html) named `food-reviews` — 1,536 dimensions, `float32`, cosine distance metric
- Filterable metadata: `Score` (number), `Summary` (string), `ProductId` (string)
- Non-filterable metadata: `Text` (full review body — stored for retrieval, not indexed for filtering)
- Demo server ingests the CSV via [`PutVectors`](https://docs.aws.amazon.com/AmazonS3/latest/API/API_s3vectors_PutVectors.html) and serves similarity search via [`QueryVectors`](https://docs.aws.amazon.com/AmazonS3/latest/API/API_s3vectors_QueryVectors.html)

Data flow: `CSV embeddings → PutVectors (batches of 50) → S3 Vector Index → QueryVectors (ANN) → nearest-neighbour reviews`

## Cost

> eu-central-1, assuming 1,000 vectors × 1,536 float32 dimensions, ~1K queries/month.

| Resource                        | Idle      | ~1K queries/month     | Cost driver                            |
| ------------------------------- | --------- | --------------------- | -------------------------------------- |
| Vector storage                  | ~$0.01/mo | ~$0.01/mo             | $0.06/GB/mo; 1K × 1536 × 4 bytes ≈ 6MB |
| PutVectors (write)              | $0.00     | $0.00 (one-time load) | $0.20/GB written; 6MB ≈ $0.001         |
| QueryVectors                    | $0.00     | ~$0.0025              | $0.0025/1K queries                     |
| GetVectors (metadata retrieval) | $0.00     | ~$0.0003              | $0.0003/1K requests                    |

**Dominant cost driver**: storage ($0.06/GB/month). At 1K vectors this is negligible — costs scale with vector count and dimension.

## Notes

- **Pre-computed vs live embeddings**: this pattern uses a dataset with embeddings already included. In production, you'd call an embedding model (Bedrock Titan Embeddings, OpenAI, etc.) at query time to embed the user's search text. The `QueryVectors` call is identical either way — only the source of the query vector changes.
- **S3 Vectors vs OpenSearch k-NN**: S3 Vectors is simpler and cheaper for pure vector search workloads. OpenSearch adds full-text search, faceting, and hybrid search but costs significantly more (~$0.09/hour for a minimal domain vs pennies/month for S3 Vectors).
- **L1 constructs only**: as of CDK v2.240, `aws-s3vectors` exposes only L1 constructs (`CfnVectorBucket`, `CfnIndex`). No L2 wrappers exist yet, so you configure every property manually.
- **Filterable vs non-filterable metadata**: all metadata keys are filterable by default. Declare keys as `nonFilterableMetadataKeys` in the index schema to store them without indexing — lower cost, no filter support. `Text` is declared non-filterable here since filtering on full review text is not useful.
- **ANN search — approximate, not exact**: `QueryVectors` uses approximate nearest-neighbour (ANN) search targeting ~90–97% recall. Results are not guaranteed to be the true closest K vectors. In practice a small fraction of queries return K-1 results rather than K — don't assert exact result counts in application logic. For exact-match retrieval by known key, use `GetVectors` instead.
- **Index immutability**: dimension count, distance metric, and `nonFilterableMetadataKeys` are fixed at creation time and **cannot be changed**. Modifying any of them requires recreating the index and re-ingesting all vectors. Plan these carefully before a production deployment.
- **Filter DSL operators**: the demo only exercises `$gte`. Full operator set:

  | Category   | Operators                                                                   |
  | ---------- | --------------------------------------------------------------------------- |
  | Comparison | `$eq` (default when no operator given), `$ne`, `$gt`, `$gte`, `$lt`, `$lte` |
  | Array      | `$in`, `$nin`                                                               |
  | Field      | `$exists`                                                                   |
  | Logical    | `$and`, `$or`                                                               |

  Only filterable metadata keys can appear in filter expressions. Syntax is MongoDB-style, e.g. `{Score: {'$gte': 4}, ProductId: {'$in': ['B001', 'B002']}}`.

- **PutVectors batch size**: the demo sends 50 vectors per request; the API maximum is 500. For bulk ingestion at scale, increase batch size to 500 — the per-index write ceiling is 1,000 requests/sec or 2,500 vectors/sec.
- **`POST /load` is idempotent**: `PutVectors` uses each row's CSV index as the vector key. Putting a vector with an existing key overwrites the stored data and metadata in place — no duplicate accumulates.
- **`QueryVectors` IAM**: when `returnMetadata: true` or a filter is present, `QueryVectors` also requires `s3vectors:GetVectors`. The stack's IAM policy grants both; a narrower read-only policy must include both permissions explicitly.
- **Alternative: pgvector on RDS** — good if you're already on Postgres and want to co-locate vector search with relational queries. Higher operational overhead, not serverless.

## Commands to play with stack

- **Deploy**:

```bash
npx cdk deploy S3Vectors
```

- **Run demo server** (deploy first):

```bash
AWS_REGION=eu-central-1 npx ts-node patterns/s3-vectors-bucket/demo_server.ts
```

- **Load all 1,000 review vectors** (idempotent, ~20s):

```bash
curl -s -X POST http://localhost:3000/load | jq
```

- **Find reviews similar to row 0** (vanilla query):

```bash
curl -s http://localhost:3000/search/0 | jq
```

- **Find similar reviews, only 5-star** (metadata filter):

```bash
curl -s 'http://localhost:3000/search/0?minScore=5&topK=5' | jq
```

- **Query by row index via POST** (programmatic):

```bash
curl -s -X POST http://localhost:3000/query \
  -H 'Content-Type: application/json' \
  -d '{"rowIndex": "42", "topK": 5, "minScore": 4}' | jq
```

- **Capture CloudFormation template**:

```bash
npx cdk synth S3Vectors > patterns/s3-vectors-bucket/cloud_formation.yaml
```

- **Delete all vectors** (required before destroy — VectorBucket must be empty):

```bash
curl -s -X DELETE http://localhost:3000/vectors | jq
```

- **Destroy**:

```bash
npx cdk destroy S3Vectors
```

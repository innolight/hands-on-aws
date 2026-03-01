# dynamodb-global-database

## Pattern Description

Demonstrates [DynamoDB Global Tables](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GlobalTables.html) — a managed multi-region, multi-active replication feature. Shows replication mechanics, eventual consistency, last-writer-wins conflict resolution, and automatic GSI replication.

- One [TableV2](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_dynamodb.TableV2.html) deployed to `eu-central-1` with a replica in `us-east-1`
- Both regions accept reads and writes with equal standing — no primary region
- Writes propagate to all replicas asynchronously, typically within < 1 second under normal conditions
- Concurrent writes to different regions are resolved by [last-writer-wins](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GlobalTables.html#GlobalTablesConsistency) using DynamoDB's internal log sequence number (LSN)
- One GSI (`byOrigin`) replicates automatically to all replicas — demonstrates that GSIs require no per-replica configuration

Data flow: `write to any region → DynamoDB Global Table replicates to all replicas → read locally from any region`

## Cost

> eu-central-1 + us-east-1, assuming ~1K writes/month across both regions.

| Resource | Idle | ~1K writes/month | Cost driver |
|---|---|---|---|
| DynamoDB writes (writing region) | $0.00 | ~$0.00 | $1.25/M WCU |
| DynamoDB replicated writes | $0.00 | ~$0.00 | $1.875/M rWCU per replica (1.5× WCU price) |
| DynamoDB reads (on-demand) | $0.00 | ~$0.00 | $0.25/M RCU |
| Global Table storage | $0.00 | ~$0.00 | $0.25/GB/month per region |

**Dominant cost driver**: replicated write cost. Each write to a Global Table costs 1 WCU in the writing region plus 1 rWCU per replica, where rWCU is priced at 1.5× WCU — making Global Tables ~2.5× the write cost of a single-region table.

## Notes

- **Replicated Write Units (rWCU)**: every write to a Global Table incurs 1 WCU (writing region) + 1 rWCU per replica region. rWCU is priced at 1.5× WCU. A table with one replica is ~2.5× the write cost of a single-region table.
- **Last-writer-wins**: concurrent writes to different regions are resolved by DynamoDB's internal LSN. The write with the higher LSN wins globally. No application-level merge function is supported.
- **Eventual consistency for cross-replica reads**: strongly consistent reads (`ConsistentRead: true`) are only honoured within the queried region's own replica. Cross-region reads are always eventually consistent. Under normal conditions replication lag is typically < 1 second.
- **Global strong consistency** (opt-in, 2024+): available via `GlobalTableVersion` with a 2× RCU surcharge. Not demonstrated here.
- **GSI replication is automatic**: GSIs defined on `TableV2` replicate to all replicas without per-replica configuration.
- **`removalPolicy: DESTROY`** on `TableV2` destroys the global table and all its replicas when the stack is deleted.
- **`TableV2` vs legacy `Table`**: the legacy `Table` construct in CDK v2 does not support the `replicas` property. Use `TableV2` for all Global Tables work.
- **Alternative: single-region DynamoDB** — if low latency for a single geography is sufficient, Global Tables add ~2.5× write cost with no benefit. Global Tables are justified when writes originate from multiple regions or when full regional HA (survive a complete region outage) is required.

## Commands to play with stack

- **Deploy**:

```bash
npx cdk deploy DynamodbGlobalDatabase
```

- **Run demo server** (must be running before the curl commands below):

```bash
AWS_REGION=eu-central-1 npx ts-node patterns/dynamodb-global-database/demo_server.ts
```

- **Write a post to EU then read immediately** (replication lag demo):

```bash
curl -s -X POST 'http://localhost:3000/users/u1/posts?region=eu-central-1' \
  -H 'Content-Type: application/json' \
  -d '{"postId":"p1","title":"Hello","body":"World"}' | jq

# Read from both regions immediately — us-east-1 may show null if you're fast enough.
# In practice replication typically completes in < 200ms; writing to US and reading
# from EU gives a better chance of catching the lag window.
curl -s 'http://localhost:3000/users/u1/posts/p1' | jq
sleep 1 && curl -s 'http://localhost:3000/users/u1/posts/p1' | jq
```

- **Write to both regions concurrently** (LWW conflict demo):

```bash
curl -s -X POST 'http://localhost:3000/users/u1/posts?multiRegionWrite=true' \
  -H 'Content-Type: application/json' \
  -d '{"postId":"p2","title":"Conflict","body":"Who wins?"}' | jq

# Immediately after: each region shows its own origin value (diverged).
curl -s 'http://localhost:3000/users/u1/posts/p2' | jq

# After ~2s: both regions converge to the same origin (LWW winner).
sleep 2 && curl -s 'http://localhost:3000/users/u1/posts/p2' | jq
```

- **List all posts for a user** (consistent read note):

```bash
curl -s 'http://localhost:3000/users/u1/posts' | jq

# ?consistent=true adds ConsistentRead per region — note the _note field in the response
# explaining that this does not guarantee cross-region consistency.
curl -s 'http://localhost:3000/users/u1/posts?consistent=true' | jq
```

- **Delete from EU, observe propagation**:

```bash
curl -s -X DELETE 'http://localhost:3000/users/u1/posts/p1?region=eu-central-1' | jq

# Immediately: EU null, US still has the item.
curl -s 'http://localhost:3000/users/u1/posts/p1' | jq

# After ~2s: both regions show null — delete tombstone propagated.
sleep 2 && curl -s 'http://localhost:3000/users/u1/posts/p1' | jq
```

- **Query with filter that uses byOrigin GSI** (shows posts written from a given region — GSI is auto-replicated):

```bash
curl -s 'http://localhost:3000/posts?region=eu-central-1' | jq
curl -s 'http://localhost:3000/posts?region=us-east-1' | jq
```

- **Observe replication metrics** (CloudWatch — DynamoDB console → Global Tables tab): around ~500ms

```bash
# macOS:
aws cloudwatch get-metric-statistics \
  --namespace AWS/DynamoDB \
  --metric-name ReplicationLatency \
  --dimensions Name=TableName,Value=global-content Name=ReceivingRegion,Value=us-east-1 \
  --start-time $(date -u -v-10M +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 60 --statistics Average \
  --region eu-central-1

# Linux:
aws cloudwatch get-metric-statistics \
  --namespace AWS/DynamoDB \
  --metric-name ReplicationLatency \
  --dimensions Name=TableName,Value=global-content Name=ReceivingRegion,Value=us-east-1 \
  --start-time $(date -u -d '10 minutes ago' +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 60 --statistics Average \
  --region eu-central-1
```

- **Capture CloudFormation template**: `npx cdk synth DynamodbGlobalDatabase > patterns/dynamodb-global-database/cloud_formation.yaml`

- **Destroy**: `npx cdk destroy DynamodbGlobalDatabase`

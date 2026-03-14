# ElastiCache Valkey Serverless

## Pattern Description

```
                     ┌─── VPC (eu-central-1) ────────────────────────────────────────┐
                     │                                                               │
                     │  ┌─ Public Subnet ────────┐    ┌─ Isolated Subnet ───────────┐│
                     │  │                        │    │                             ││
curl localhost:3000 ──▶ │  EC2 t4g.nano          │    │  ElastiCache Serverless     ││
 (SSM port-forward)  │  │  demo_server :3000  :6379──▶│  :6379  reads + writes      ││
                     │  │                     :6380──▶│  :6380  eventually-consist. ││
                     │  │  [DemoServerSG]        │    │  [CacheSG]                  ││
                     │  │                        │    │  TLS on · RBAC (appuser)    ││
                     │  └──────────┬─────────────┘    │  3-AZ redundancy (auto)     ││
                     │             │ :443             └─────────────────────────────┘│
                     │             ▼                                                 │
                     │       Secrets Manager (appuser password)                      │
                     └───────────────────────────────────────────────────────────────┘
```

- **[ElastiCache Serverless](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/serverless.html)** — zero-capacity-planning cache. AWS automatically scales compute and memory; no node type selection, no shard count, no parameter group tuning.
- **[Valkey](https://valkey.io/)** engine with **[TLS](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/in-transit-encryption.html)** always on (mandatory for serverless) and **[RBAC](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Clusters.RBAC.html)** enforced via a disabled default user + named `appuser`.
- **Single endpoint hostname, two ports**: port 6379 handles both reads and writes; port 6380 handles eventually-consistent reads only (lower latency, uses `READONLY`). Both ports resolve to the same hostname — AWS routes internally. Client must use `iovalkey.Cluster` — serverless requires cluster-mode protocol regardless of topology.
- **[ECPUs](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/serverless-usage-and-billing.html)** (ElastiCache Processing Units) — the serverless billing unit for compute. 1 ECPU ≈ 1 simple GET/SET on a small value. CPU-intensive commands (e.g. `LRANGE`, `SINTERSTORE`) consume more ECPUs per call.
- Automatic 3-AZ redundancy — no `multiAzEnabled` flag or replica count to configure.
- Demo EC2 in the same VPC connects directly to both endpoints, showcasing **retry with exponential backoff + jitter** and **command pipelining**.

### Serverless vs node-based comparison

| | Serverless | Node-based (cluster) |
|---|---|---|
| Capacity planning | None — auto-scales | Node type + shard count + replicas |
| Billing unit | ECPUs/sec + GB-hour | Instance hours (always on) |
| Parameter group | Not supported — AWS manages | Configurable (eviction, slow log, etc.) |
| Subnet group | Not needed — subnets passed directly | Required |
| Multi-AZ | Always — automatic | Requires `multiAzEnabled: true` + replicas |
| Minimum idle cost | ~$90/month (1000 ECPU/s baseline) | ~$12/month (cache.t4g.micro × 1) |
| Best for | Variable / unpredictable traffic | Steady, predictable workloads |

## Cost

> Region: `eu-central-1`. Workload assumption: idle demo (minimal ECPUs consumed, 1 GB storage cap).

| Resource | Idle | ~100k ops/day | Cost driver |
|---|---|---|---|
| Serverless compute | ~$90/month | ~$90/month | 1000 ECPU/s minimum floor |
| Serverless storage | ~$0.10/month | ~$0.10/month | 1 GB × $0.10/GB-hour |
| App Server EC2 t4g.nano | ~$3/month | ~$3/month | Instance hours |

**Dominant cost driver**: the 1000 ECPU/s minimum baseline (~$0.0034/ECPU-hour). Even at zero traffic you pay for the floor. Node-based cache.t4g.micro costs ~$12/month — serverless is more expensive at low utilisation but cheaper than large node fleets under burst traffic.

## Notes

- **No parameter group**: AWS manages eviction policy, defrag, slow log, and all other tuning internally. The only configurable engine settings are `cacheUsageLimits` (ECPU/s range, max storage), `snapshotRetentionLimit`, `dailySnapshotTime`, and `kmsKeyId`. If you need to control `maxmemory-policy`, `timeout`, or other Valkey knobs, use node-based `CfnReplicationGroup` instead.
- **Cost unpredictability**: ECPU consumption per command is opaque — expensive commands (`SINTERSTORE`, `SORT`, large `LRANGE`) consume more ECPUs than simple GET/SET with no advance visibility. A traffic spike or a few heavy commands can produce unexpected bills. The `maxEcpuPerSecond` cap throttles rather than auto-scales gracefully: hitting the cap causes request failures, not just slowness.
- **No eviction fallback**: `maxmemory-policy` is not configurable. If you hit the storage cap, writes fail — there is no LRU eviction. Defensive TTLs on all keys are essential.
- **No scale-to-zero**: the 1000 ECPU/s minimum floor charges ~$90/month regardless of traffic.
- **Limited observability**: `SLOWLOG GET` is unavailable and `slowlog-log-slower-than` cannot be tuned. Identifying expensive commands requires CloudWatch metrics (`CacheHits`, `ElastiCacheCPUUtilization`) — less precise than node-based diagnostics.
- **Failover is opaque**: node-based setups expose replica lag, replication offset, and per-shard failover events. Serverless provides only aggregate CloudWatch metrics with no visibility into the underlying redundancy mechanism.
- **No in-place engine version upgrade**: upgrading requires creating a new serverless cache and migrating data, unlike node-based rolling upgrades on an existing replication group.
- **Client must use cluster protocol**: `iovalkey.Cluster` is required even though serverless is not a traditional cluster. The two endpoints present a cluster-mode interface; AWS handles routing transparently.
- **Reader port (`scaleReads: 'slave'`)**: routes read commands to port 6380 (eventually-consistent, lower latency). Use `'master'` to keep all reads on port 6379 for strict consistency.
- **Pipeline benefit**: pipelining batches N commands into one network round trip. With RTT ~1ms inside a VPC, 100 sequential SETs ≈ 100ms vs 100 pipelined SETs ≈ 1–2ms.
- **RBAC is mandatory**: serverless rejects connections without a user group. The disabled default user enforces that all clients must authenticate as a named user.

## Commands to play with stack

```bash
# Deploy cache stack first, then app stack
npx cdk deploy ElastiCacheValkeyServerless ElastiCacheValkeyServerlessApp

# Fetch instance ID and asset URL from stack outputs
DEMO_SERVER=$(aws cloudformation describe-stacks --stack-name ElastiCacheValkeyServerlessApp \
  --query "Stacks[0].Outputs[?OutputKey=='DemoServerInstanceId'].OutputValue" --output text)

# Terminal 1: SSM into the demo server, download the bundle, run it
aws ssm start-session --target "$DEMO_SERVER"
# On the instance (wait ~60s after first deploy for user data to finish):
ASSET_URL=$(aws cloudformation describe-stacks --stack-name ElastiCacheValkeyServerlessApp \
  --query "Stacks[0].Outputs[?OutputKey=='DemoServerAssetS3Url'].OutputValue" --output text)
aws s3 cp "$ASSET_URL" /tmp/bundle.zip && unzip -o /tmp/bundle.zip -d /tmp/demo/
AWS_REGION=eu-central-1 node /tmp/demo/demo_server.js

# Terminal 2: port-forward so you can reach the server from your machine
aws ssm start-session --target "$DEMO_SERVER" \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["3000"],"localPortNumber":["3000"]}'

# Interact with the demo server
curl "localhost:3000/set?key=hello&value=world"
curl "localhost:3000/get?key=hello"
curl "localhost:3000/del?key=hello"

# Pipeline benchmark: compare sequential vs batched writes
curl "localhost:3000/pipeline?n=100"
# Returns: {"n":100,"sequential_ms":120,"pipeline_ms":3,"speedup":"40.0x"}

# Server info and connection status
curl "localhost:3000/info"

# Capture CloudFormation templates
npx cdk synth ElastiCacheValkeyServerless > patterns/elasticache-valkey-serverless/cloud_formation.yaml
npx cdk synth ElastiCacheValkeyServerlessApp > patterns/elasticache-valkey-serverless/cloud_formation_app.yaml

# Destroy (cache stack takes ~5 min to delete)
npx cdk destroy ElastiCacheValkeyServerlessApp ElastiCacheValkeyServerless
```

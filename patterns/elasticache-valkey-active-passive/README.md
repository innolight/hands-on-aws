# ElastiCache Valkey (Non-Cluster Mode)

## Pattern Description

- [Amazon ElastiCache](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/WhatIs.html) managed cache cluster running [Valkey 8](https://valkey.io/), an open-source Redis-compatible engine
- Non-cluster (replication group) mode: one primary node + optional read replicas, all sharing the same keyspace
- Topology controlled via `-c nodes=N` at deploy time:

| `-c nodes=` | Topology | Failover | RW endpoint | RO endpoint |
|---|---|---|---|---|
| `1` (default) | 1 node, no HA | disabled | Primary | Primary (same) |
| `2+` | 1 primary + (N-1) replicas | enabled, Multi-AZ | Primary | Reader (load-balanced across replicas) |

- Data flow: `demo_server` → SSM port forward → EC2 bastion ([`ssm-bastion`](../ssm-bastion/)) → [ElastiCache](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Endpoints.html) private endpoint
- Auth: [RBAC](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Clusters.RBAC.html) via `CfnUser` / `CfnUserGroup` — `appuser` has full access; `default` user is disabled
- TLS in transit + encryption at rest
- VPC from [`vpc-subnets`](../vpc-subnets/) stack; bastion from [`ssm-bastion`](../ssm-bastion/) stack
- Password stored in [Secrets Manager](https://docs.aws.amazon.com/secretsmanager/latest/userguide/intro.html) (~$0.40/mo)

**Key learning: always create separate RW and RO clients.** When scaling from `nodes=1` to `nodes=3`, the client code is unchanged — the RO client simply starts hitting a replica via the reader endpoint.

## Cost

Region: `eu-central-1`. Assumes 24/7 idle, minimal throughput.

| Resource | Idle | ~1 unit/mo | Cost driver |
|---|---|---|---|
| cache.t4g.micro | ~$12/node/mo | — | Per-node-hour billing |
| EC2 t4g.nano bastion | ~$3/mo | — | Instance uptime |
| Secrets Manager | ~$0.40/mo | — | Per-secret fee |
| NAT gateway | $0 | — | None (SSM via public subnet) |

Dominant cost: cache nodes (~$12 each). A 3-node cluster costs ~$39/mo in cache alone.

## Notes

- **`CfnReplicationGroup` vs `CfnCacheCluster`**: `CfnCacheCluster` does not support `transitEncryptionEnabled`. Since TLS is required for RBAC, `CfnReplicationGroup` is used even for a single node.
- **Primary vs reader endpoints**: The primary endpoint always points to the writable node. The reader endpoint load-balances across all replicas (when nodes>1). When nodes=1, both endpoints resolve to the same host.
- **TLS `servername` through the tunnel**: The SSM port forward creates a TCP tunnel from `localhost` to the ElastiCache endpoint. Without `servername`, the TLS handshake fails because the certificate CN doesn't match `localhost`. Setting `tls: { servername: <elasticache-host> }` sends the correct SNI header through the tunnel.
- **Replication lag**: Valkey replication is asynchronous. A write on the primary may not be visible on a replica for a few milliseconds. The `/write-read-test` endpoint demonstrates this — it may return `"replicated": false` on a loaded cluster.
- **Cluster mode (sharded)**: This pattern is non-cluster (single shard). For horizontal scaling across multiple shards, see the `elasticache-valkey-cluster` pattern.
- **Valkey in-place updates not supported**: CloudFormation updates to the replication group (changing node count, adding a parameter group, etc.) call the `ModifyReplicationGroup` API, which does not support the Valkey engine. Any update will fail with `InvalidParameterValue`. The only workaround is destroy + redeploy: `npx cdk destroy ElastiCacheValkeyActivePassive` then redeploy with the target config. This is a current AWS API limitation — `CreateReplicationGroup` supports Valkey but `ModifyReplicationGroup` does not.
- **Node restarts**: ElastiCache nodes do restart — AWS applies OS patches and engine upgrades during the weekly maintenance window, and hardware failures cause unplanned replacements. How much this matters depends on topology:
  - **Multi-node** (`nodes=2+`): a replica restart resyncs from the primary automatically; a primary crash triggers automatic failover to the replica in ~30–60s. Data is preserved in both cases.
  - **Single-node** (`nodes=1`): a restart empties the cache. If the backing database can absorb the cold-cache traffic spike while the cache re-warms, this is acceptable. If not (e.g. session store, expensive computed results), consider a multi-node topology instead.
- **AOF (Append-Only File) is not supported in ElastiCache**: `appendonly` and `appendfsync` cannot be set via a parameter group — the API rejects them with "parameter cannot be modified". For single-node durability across restarts, ElastiCache offers no AOF equivalent; the only option is accepting cache loss on restart or switching to multi-node.

## Commands

### Deploy

Depends on `VpcSubnets` and `SsmBastion` stacks.

```bash
# Single node (cheapest, no HA)
npx cdk deploy VpcSubnets SsmBastion ElastiCacheValkeyActivePassive -c nodes=1

# 3 nodes: 1 primary + 1 replicas (Multi-AZ, automatic failover)
npx cdk deploy VpcSubnets SsmBastion ElastiCacheValkeyActivePassive -c nodes=2
```

### SSM Port Forwarding (two terminals)

```bash
# Fetch outputs
BASTION=$(aws cloudformation describe-stacks --stack-name SsmBastion \
  --query "Stacks[0].Outputs[?OutputKey=='BastionInstanceId'].OutputValue" --output text)
PRIMARY=$(aws cloudformation describe-stacks --stack-name ElastiCacheValkeyActivePassive \
  --query "Stacks[0].Outputs[?OutputKey=='ValkeyPrimaryEndpoint'].OutputValue" --output text)
READER=$(aws cloudformation describe-stacks --stack-name ElastiCacheValkeyActivePassive \
  --query "Stacks[0].Outputs[?OutputKey=='ValkeyReaderEndpoint'].OutputValue" --output text)

# SSM Session Manager plugin needs to be installed before starting SSM session. 
# Installation instruction https://docs.aws.amazon.com/systems-manager/latest/userguide/install-plugin-macos-overview.html

# Terminal 1: Primary (RW) — local port 6379
aws ssm start-session \
  --target "$BASTION" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "{\"host\":[\"$PRIMARY\"],\"portNumber\":[\"6379\"],\"localPortNumber\":[\"6379\"]}"

# Terminal 2: Reader (RO) — local port 6380
aws ssm start-session \
  --target "$BASTION" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "{\"host\":[\"$READER\"],\"portNumber\":[\"6379\"],\"localPortNumber\":[\"6380\"]}"
```

### Run Demo Server

```bash
AWS_REGION=eu-central-1 npx ts-node patterns/elasticache-valkey-active-passive/demo_server.ts
```

### Interact

```bash
# Write a key (goes to primary via RW client)
curl "http://localhost:3000/set?key=hello&value=world"

# Read a key (goes to reader via RO client — may be stale on multi-node)
curl "http://localhost:3000/get?key=hello"

# List all keys (RO client — never use KEYS in production)
curl "http://localhost:3000/keys"

# Delete a key (RW client)
curl "http://localhost:3000/del?key=hello"

# Observe replication info (role, offset, replica lag)
curl "http://localhost:3000/info" | jq .

# Write-then-read test demonstrating eventual consistency
curl "http://localhost:3000/write-read-test" | jq .
```

### Observe Logs

```bash
# SSM port-forward sessions show connection events in the terminal
# Demo server logs each request to stdout
```

### Destroy

```bash
# Destroy in reverse dependency order; keep VpcSubnets if shared with other stacks
npx cdk destroy ElastiCacheValkeyActivePassive SsmBastion
```

### Capture CloudFormation YAML

```bash
npx cdk synth ElastiCacheValkeyActivePassive -c nodes=1 > patterns/elasticache-valkey-active-passive/cloud_formation.yaml
```

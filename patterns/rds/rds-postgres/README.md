# RDS PostgreSQL — Single-AZ / Multi-AZ Standard + RDS Proxy

## Pattern Description

```
Demo Server (local)
  │  localhost:5432
  ▼
SSM Port Forwarding
  │
  ▼
EC2 Bastion (public subnet)
  │  PostgreSQL (SSL)
  ▼
RDS Proxy (isolated subnet)
  │  connection pool
  ▼
RDS PostgreSQL 17 (isolated subnet)
  ├── Single-AZ (default)   — 1 instance, no standby
  └── Multi-AZ (-c multiAz=true) — primary + hidden sync standby in second AZ
```

- [Amazon RDS for PostgreSQL](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_PostgreSQL.html) — managed PostgreSQL with automated patching, backups, and failover
- [RDS Proxy](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html) — connection pooler that reduces failover time and absorbs connection spikes (e.g. Lambda)
- Single-AZ: one instance, no HA. AZ failure = downtime until restore from snapshot.
- Multi-AZ (`-c multiAz=true`): synchronous standby in a second AZ. Failover is automatic (DNS CNAME flip) in 60–120s. **The standby is invisible — it cannot serve reads.**
- Credentials auto-generated and stored in [Secrets Manager](https://docs.aws.amazon.com/secretsmanager/latest/userguide/intro.html)
- DB instance and proxy placed in **isolated subnets** (no internet route)
- VPC from [`vpc-subnets`](../../vpc-subnets/), bastion from [`ssm-bastion`](../../ssm-bastion/)

## RDS Knobs

### Instance

| Knob | Default in this stack | When to change | When NOT to change |
|------|----------------------|----------------|--------------------|
| `instanceType` | `db.t4g.micro` | Scale up to `t4g.small` / `m7g.large` when CPU or memory is a bottleneck | Keep micro for dev/test; Graviton (t4g/m7g) is ~10% cheaper than x86 (t3/m6i) at the same tier |
| `engineVersion` | `17.7` | Upgrade to newer minor releases for security patches; plan major upgrades carefully (backward-compat testing required) | Avoid downgrading — RDS doesn't support it |
| `multiAz` | `false` | Set to `true` for any production workload where downtime is unacceptable | Single-AZ is fine for dev/test/PoC |
| `allocatedStorage` | `20 GiB` | Raise if your dataset exceeds 20 GiB | Don't over-provision; `maxAllocatedStorage` handles growth automatically |
| `storageType` | `GP3` | Switch to `IO2` only when you need >16,000 IOPS or sub-millisecond consistent latency | GP3 gives 3,000 IOPS and 125 MiBps baseline free — sufficient for most workloads |
| `maxAllocatedStorage` | `100 GiB` | Raise for large datasets; set equal to `allocatedStorage` to disable autoscaling | Keep autoscaling enabled in production — RDS grows storage when free space < 10% |
| `backupRetention` | `Duration.days(1)` | Increase to 7–35 days in production for point-in-time restore (PITR) | Don't set to 0 — that disables automated backups and blocks read replica creation |
| `storageEncrypted` | `true` (RDS default) | Always on | Never disable — required for compliance and enables KMS key rotation |
| `deletionProtection` | `false` | Set to `true` in production to prevent accidental deletion | Keep `false` in dev so `cdk destroy` works |
| `removalPolicy` | `DESTROY` | Set to `SNAPSHOT` or `RETAIN` in production | Keep `DESTROY` in dev — `SNAPSHOT` leaves orphan snapshots that cost money |
| `autoMinorVersionUpgrade` | `true` (RDS default) | Leave enabled — minor upgrades include security patches, applied during maintenance window | Disable only if your application is sensitive to minor-version behaviour changes (rare) |
| `enablePerformanceInsights` | `false` (RDS default) | Enable for production to diagnose slow queries and wait events. Free for 7-day retention on t-class instances | Not needed for dev/test |
| `monitoringInterval` | not set (disabled) | Set to `Duration.seconds(60)` in production to enable [Enhanced Monitoring](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_Monitoring.OS.html) (OS-level metrics) | Adds ~$1/mo to CloudWatch costs; skip for dev |
| `cloudwatchLogsExports` | not set | Add `['postgresql']` to ship PostgreSQL logs to CloudWatch — useful for slow query analysis | Adds CloudWatch storage cost; filter with `log_min_duration_statement` to avoid noise |
| `parameterGroup` / `parameters` | RDS defaults | Use a custom parameter group to tune `work_mem`, `max_connections`, `log_min_duration_statement`, etc. | Don't use both `parameterGroup` and `parameters` — they're mutually exclusive |

### RDS Proxy

| Knob | Default in this stack | When to change | When NOT to change |
|------|----------------------|----------------|--------------------|
| `maxConnectionsPercent` | `90` | Lower to 70–80 if other clients (e.g. migration tools, BI) also connect directly | Don't set to 100 — leaves no headroom for direct admin connections |
| `maxIdleConnectionsPercent` | `50` | Lower for cost savings if workload is very spiky (idle connections still count) | Keep ≥ 10 — too low causes connection latency spikes on traffic bursts |
| `borrowTimeout` | `30s` | Reduce to 5–10s for latency-sensitive APIs where fast failure is better than waiting | Don't reduce below the 95th-percentile DB response time — legitimate slow queries will time out |
| `idleClientTimeout` | `15 min` | Reduce for Lambda workloads (Lambda execution time is 15 min max anyway) | Don't reduce below your application's connection keep-alive interval |
| `requireTLS` | `true` | Always on | Never disable — data in transit must be encrypted |

## Cost

Region: `eu-central-1`. Assumes 24/7 idle, minimal throughput.

| Resource | Idle | ~N unit/month | Cost driver |
|----------|------|--------------|-------------|
| RDS `db.t4g.micro` Single-AZ | ~$13/mo | — | Per-instance-hour billing |
| RDS `db.t4g.micro` Multi-AZ | ~$26/mo | — | 2× instance hours (standby is invisible but billed) |
| GP3 storage 20 GiB | ~$2.30/mo | — | $0.115/GiB-month |
| RDS Proxy | ~$18/mo | — | $0.015/vCPU-hour × 2 ACUs (minimum) |
| Secrets Manager | ~$0.40/mo | — | Per-secret fee |
| EC2 t4g.nano bastion | ~$3/mo | — | Instance uptime |

Dominant cost: RDS Proxy (~$18/mo) at the minimum ACU floor. Remove the proxy if your workload is not Lambda-based and you don't need fast failover.

## Notes

- **Multi-AZ standby is NOT readable.** The standby in Multi-AZ Standard accepts no connections. You pay 2× for HA only — no read scaling. Use [`rds-readable-standbys`](../rds-readable-standbys/) to get both HA and read scaling.
- **RDS Proxy reduces failover time.** Without the proxy, an application reconnects directly to the DNS endpoint, which takes 60–120s to flip. With the proxy, the proxy retries internally — the application typically sees <30s of reconnect activity.
- **Proxy requires a Secrets Manager secret.** The proxy fetches credentials from Secrets Manager at runtime. This is why `requireTLS: true` is non-negotiable — credentials travel over the proxy connection.
- **`borrowTimeout` vs `connectionTimeoutMillis`.** `borrowTimeout` is the proxy-side wait (how long the proxy waits for a free pooled connection). `connectionTimeoutMillis` in the `pg` driver is the client-side wait (how long the app waits to connect to the proxy). Both matter for tail latency.
- **t4g.micro `max_connections` ≈ 87.** The formula is `LEAST(DBInstanceClassMemory/9531392, 5000)`. For 1 GiB RAM: `1 GiB / 9531392 bytes ≈ 111`, then minus overhead ≈ 87. The proxy's 90% limit = ~78 pooled connections.

## Commands

### Deploy

Depends on `VpcSubnets` and `SsmBastion` stacks.

```bash
# Single-AZ (cheapest, no HA)
npx cdk deploy VpcSubnets SsmBastion RdsPostgres

# Multi-AZ (automatic failover, 2× cost)
npx cdk deploy VpcSubnets SsmBastion RdsPostgres -c multiAz=true
```

### SSM Port Forwarding

```bash
# Fetch outputs
BASTION=$(aws cloudformation describe-stacks --stack-name SsmBastion \
  --query "Stacks[0].Outputs[?OutputKey=='BastionInstanceId'].OutputValue" --output text)
PROXY=$(aws cloudformation describe-stacks --stack-name RdsPostgres \
  --query "Stacks[0].Outputs[?OutputKey=='ProxyEndpoint'].OutputValue" --output text)

# Terminal 1: tunnel to RDS Proxy on local port 5432
aws ssm start-session \
  --target "$BASTION" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "{\"host\":[\"$PROXY\"],\"portNumber\":[\"5432\"],\"localPortNumber\":[\"5432\"]}"
```

### Run Demo Server

```bash
AWS_REGION=eu-central-1 npx ts-node patterns/rds/demo_server.ts rds-postgres
```

### Interact

```bash
# Write a quote (RW pool -> proxy -> DB)
curl -s -X POST http://localhost:3000/quotes \
  -H "Content-Type: application/json" \
  -d '{"text":"In the beginning was the command line.","author":"Neal Stephenson"}' | jq .

# Read all quotes (RO pool -> proxy -> DB)
curl -s http://localhost:3000/quotes | jq .

# Health check (tests both pools)
curl -s http://localhost:3000/health | jq .

# Write-then-read (demonstrates that proxy has no replication lag)
curl -s http://localhost:3000/write-read-test | jq .
```

### Destroy

```bash
npx cdk destroy RdsPostgres
```

### Capture CloudFormation YAML

```bash
npx cdk synth RdsPostgres > patterns/rds/rds-postgres/cloud_formation_single_instance.yaml
npx cdk synth RdsPostgres -c multiAz=true > patterns/rds/rds-postgres/cloud_formation_multiaz.yaml
```

## Entity Relation of AWS Resources

```mermaid
flowchart TB
    subgraph VpcSubnets["VpcSubnets (imported)"]
        VPC["AWS::EC2::VPC"]
        IsolSub["AWS::EC2::Subnet\n(3x isolated)"]
    end

    subgraph SsmBastion["SsmBastion (imported)"]
        BastionSG["AWS::EC2::SecurityGroup\n(Bastion)"]
    end

    subgraph Stack["RdsPostgres"]
        DbSG["AWS::EC2::SecurityGroup\n(DB)"]
        SubnetGrp["AWS::RDS::DBSubnetGroup"]
        Secret["AWS::SecretsManager::Secret"]
        SecAttach["AWS::SecretsManager::SecretTargetAttachment"]
        Instance["AWS::RDS::DBInstance\n(Multi-AZ)"]
        ProxyRole["AWS::IAM::Role\n(Proxy)"]
        ProxyPol["AWS::IAM::Policy\n(Proxy)"]
        Proxy["AWS::RDS::DBProxy"]
        ProxyTG["AWS::RDS::DBProxyTargetGroup"]
    end

    VPC --> |contains| IsolSub

    DbSG --> |in| VPC
    DbSG --> |allows traffic from| BastionSG

    SubnetGrp --> |placed in| IsolSub

    SecAttach --> |wraps| Secret
    SecAttach --> |linked to| Instance
    Instance --> |secured by| DbSG
    Instance --> |placed in| SubnetGrp

    ProxyPol --> |grants permissions to| ProxyRole
    ProxyPol --> |allows read from| SecAttach
    Proxy --> |runs as| ProxyRole
    Proxy --> |authenticates via| SecAttach
    Proxy --> |secured by| DbSG
    Proxy --> |placed in| IsolSub

    ProxyTG --> |belongs to| Proxy
    ProxyTG --> |routes to| Instance
```

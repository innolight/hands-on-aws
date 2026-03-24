# RDS PostgreSQL — Single-AZ / Multi-AZ Standard (optional RDS Proxy)

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
  │
  ├── [rdsProxyEnabled=true] ──▶ RDS Proxy (isolated subnet)
  │                                │  connection pool
  │                                ▼
  └── [default: direct] ─────────▶ RDS PostgreSQL 17 (isolated subnet)
                                     ├── Single-AZ (default)   — 1 instance, no standby
                                     └── Multi-AZ (-c multiAz=true) — primary + hidden sync standby
```

- [Amazon RDS for PostgreSQL](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_PostgreSQL.html) — managed PostgreSQL with automated patching, backups, and failover
- [RDS Proxy](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html) — **opt-in** (`rdsProxyEnabled: true`); connection pooler that reduces failover time and absorbs connection spikes (e.g. Lambda)
- Single-AZ: one instance, no HA. AZ failure = downtime until restore from snapshot.
- Multi-AZ (`-c multiAz=true`): synchronous standby in a second AZ. Failover is automatic (DNS CNAME flip) in 60–120s. **The standby is invisible — it cannot serve reads.**
- Credentials auto-generated and stored in [Secrets Manager](https://docs.aws.amazon.com/secretsmanager/latest/userguide/intro.html)
- DB instance placed in **isolated subnets** (no internet route); proxy shares the same subnets when enabled
- VPC from [`vpc-subnets`](../../vpc-subnets/), bastion from [`ssm-bastion`](../../ssm-bastion/)

### When to enable RDS Proxy (`rdsProxyEnabled: true`)

- **Lambda + RDS** (canonical use case) — each Lambda cold start opens a new connection; the proxy pools them so 500 concurrent invocations share ~20–50 backend connections
- **ECS/Fargate with aggressive auto-scaling** — many short-lived tasks risk exhausting `max_connections`; proxy provides a central connection governor
- **Fast failover requirement** — proxy reconnects to the new primary in <5s vs 60–120s for direct DNS failover
- **IAM-based DB auth at scale** — proxy caches IAM auth tokens centrally, avoiding per-connection STS calls from every client

### When NOT to enable (default off)

- **Low-concurrency workloads** — a handful of long-lived servers with a small connection pool will never approach `max_connections`; pooling adds no value
- **Dev/test environments** — proxy costs ~$18/mo, more than a `db.t4g.micro` itself (~$13/mo); wasteful for throwaway stacks
- **Heavy session state** — `SET` variables, temp tables, and `PREPARE` cause the proxy to "pin" a connection to one client, disabling multiplexing and negating the pooling benefit
- **Latency-sensitive single-query workloads** — the proxy adds an extra network hop (~1–5ms per query); for persistent connections this is rarely noticeable, but it matters for sub-millisecond SLOs

## Cost

Region: `eu-central-1`. Assumes 24/7 idle, minimal throughput.

| Resource                     | Idle      | ~N unit/month | Cost driver                                          |
| ---------------------------- | --------- | ------------- | ---------------------------------------------------- |
| RDS `db.t4g.micro` Single-AZ | ~$13/mo   | —             | Per-instance-hour billing                            |
| RDS `db.t4g.micro` Multi-AZ  | ~$26/mo   | —             | 2× instance hours (standby is invisible but billed)  |
| GP3 storage 20 GiB           | ~$2.30/mo | —             | $0.115/GiB-month                                     |
| RDS Proxy (opt-in)           | ~$18/mo   | —             | $0.015/vCPU-hour × 2 vCPUs (minimum); off by default |
| Secrets Manager              | ~$0.40/mo | —             | Per-secret fee                                       |
| EC2 t4g.nano bastion         | ~$3/mo    | —             | Instance uptime                                      |

Dominant cost without proxy: RDS instance (~$13/mo). With proxy enabled (`rdsProxyEnabled: true`), the proxy (~$18/mo) becomes the dominant cost at the minimum vCPU floor.

## Notes

- **Multi-AZ standby is NOT readable.** The standby in Multi-AZ Standard accepts no connections. You pay 2× for HA only — no read scaling. Use [`rds-readable-standbys`](../rds-readable-standbys/) to get both HA and read scaling.
- **When proxy is enabled — failover time.** Without the proxy, an application reconnects directly to the DNS endpoint, which takes 60–120s to flip. With the proxy, the proxy retries internally — the application typically sees <30s of reconnect activity.
- **When proxy is enabled — Secrets Manager dependency.** The proxy fetches credentials from Secrets Manager at runtime. This is why `requireTLS: true` is non-negotiable — credentials travel over the proxy connection.
- **When proxy is enabled — `borrowTimeout` vs `connectionTimeoutMillis`.** `borrowTimeout` is the proxy-side wait (how long the proxy waits for a free pooled connection). `connectionTimeoutMillis` in the `pg` driver is the client-side wait (how long the app waits to connect to the proxy). Both matter for tail latency.
- **t4g.micro `max_connections` ≈ 87.** The formula is `LEAST(DBInstanceClassMemory/9531392, 5000)`. For 1 GiB RAM: `1 GiB / 9531392 bytes ≈ 111`, then minus overhead ≈ 87. The proxy's 90% limit = ~78 pooled connections.

## Commands

### Deploy

```bash
# Single-AZ, no proxy (cheapest, default)
npx cdk deploy VpcSubnets SsmBastion RdsPostgres

# Multi-AZ (automatic failover, 2× cost)
npx cdk deploy VpcSubnets SsmBastion RdsPostgres -c multiAz=true
```

To enable RDS Proxy, pass `rdsProxyEnabled: true` when instantiating the stack in `bin/cdk.ts`:

```typescript
new RdsPostgresStack(app, rdsPostgresStackName, {
  vpc: vpcStack.vpc,
  bastionSG: bastionStack.bastionSG,
  rdsProxyEnabled: true, // add this line
});
```

### SSM Port Forwarding

```bash
BASTION=$(aws cloudformation describe-stacks --stack-name SsmBastion \
  --query "Stacks[0].Outputs[?OutputKey=='BastionInstanceId'].OutputValue" --output text)

# Option A: direct to DB (default, no proxy)
DB_HOST=$(aws cloudformation describe-stacks --stack-name RdsPostgres \
  --query "Stacks[0].Outputs[?OutputKey=='DbEndpoint'].OutputValue" --output text)

aws ssm start-session \
  --target "$BASTION" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "{\"host\":[\"$DB_HOST\"],\"portNumber\":[\"5432\"],\"localPortNumber\":[\"5432\"]}"

# Option B: via RDS Proxy (rdsProxyEnabled=true)
PROXY=$(aws cloudformation describe-stacks --stack-name RdsPostgres \
  --query "Stacks[0].Outputs[?OutputKey=='ProxyEndpoint'].OutputValue" --output text)

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
npx cdk destroy SsmBastion RdsPostgres
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
        ParamGrp["AWS::RDS::DBParameterGroup"]
        Secret["AWS::SecretsManager::Secret"]
        SecAttach["AWS::SecretsManager::SecretTargetAttachment"]
        Instance["AWS::RDS::DBInstance\n(Multi-AZ)"]
        subgraph ProxyOpt["optional: rdsProxyEnabled=true"]
            ProxyRole["AWS::IAM::Role\n(Proxy)"]
            ProxyPol["AWS::IAM::Policy\n(Proxy)"]
            Proxy["AWS::RDS::DBProxy"]
            ProxyTG["AWS::RDS::DBProxyTargetGroup"]
        end
    end
    style ProxyOpt stroke-dasharray: 5 5

    VPC --> |contains| IsolSub

    DbSG --> |in| VPC
    DbSG --> |allows traffic from| BastionSG

    SubnetGrp --> |placed in| IsolSub

    SecAttach --> |wraps| Secret
    SecAttach --> |linked to| Instance
    Instance --> |secured by| DbSG
    Instance --> |placed in| SubnetGrp
    Instance --> |configured by| ParamGrp

    ProxyPol --> |grants permissions to| ProxyRole
    ProxyPol --> |allows read from| SecAttach
    Proxy --> |runs as| ProxyRole
    Proxy --> |authenticates via| SecAttach
    Proxy --> |secured by| DbSG
    Proxy --> |placed in| IsolSub

    ProxyTG --> |belongs to| Proxy
    ProxyTG --> |routes to| Instance
```

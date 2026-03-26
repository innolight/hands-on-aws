# Aurora Global Database

```
┌──────────────────────────────────────────────────────────┐
│  eu-central-1 (Primary)                                  │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Aurora Global Cluster (aurora-global-demo)        │  │
│  │                                                    │  │
│  │  ┌──────────────────────────────────────────────┐  │  │
│  │  │  Primary Cluster (RdsAuroraGlobalPrimary)    │  │  │
│  │  │                                              │  │  │
│  │  │  ┌─────────────────────┐                     │  │  │
│  │  │  │  Writer (t4g.med.)  │  ← SSM tunnel       │  │  │
│  │  │  │  (read + write)     │    localhost:5432   │  │  │
│  │  │  └─────────────────────┘                     │  │  │
│  │  │                                              │  │  │
│  │  │  ┌────────────────────────────────────────┐  │  │  │
│  │  │  │       Shared Distributed Storage       │  │  │  │
│  │  │  └──────────────────┬─────────────────────┘  │  │  │
│  │  └─────────────────────┼────────────────────────┘  │  │
│  └────────────────────────┼───────────────────────────┘  │
└───────────────────────────┼──────────────────────────────┘
                            │ storage replication
                            │ typical lag < 1 second
                            ▼
┌──────────────────────────────────────────────────────────┐
│  us-east-1 (Secondary)                                   │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Secondary Cluster (RdsAuroraGlobalSecondary)      │  │
│  │                                                    │  │
│  │  ┌─────────────────────┐                           │  │
│  │  │  Instance (t4g.med.)│  ← SSM tunnel             │  │
│  │  │  (read-only)        │    localhost:5433         │  │
│  │  └─────────────────────┘                           │  │
│  │                                                    │  │
│  │  ┌────────────────────────────────────────────┐    │  │
│  │  │   Replicated Storage (read-only local copy)│    │  │
│  │  └────────────────────────────────────────────┘    │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

- **[Aurora Global Database](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database.html)** — one primary cluster (read-write) + up to 5 secondary clusters in different regions. Storage is replicated cross-region at the storage layer, not via WAL streaming. Typical replication lag < 1 second.
- **[GlobalCluster](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_rds.CfnGlobalCluster.html)** (`AWS::RDS::GlobalCluster`) — the parent resource that wraps an existing primary Aurora cluster and manages secondary enrollment.
- **Primary cluster** (eu-central-1) — 1 writer (`t4g.medium`). Add readers for local read scaling (up to 15 per cluster).
- **Secondary cluster** (us-east-1) — 1 read-only instance (`t4g.medium`). Write forwarding is disabled (see Notes).
- **[Secrets Manager](https://docs.aws.amazon.com/secretsmanager/latest/userguide/intro.html)** — managed-rotation secret in the primary region. The secondary inherits credentials; no separate secret is created.
- **[Performance Insights](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/USER_PerfInsights.html)** — enabled on all instances, 7-day free retention.
- **[Enhanced Monitoring](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/USER_Monitoring.OS.html)** — OS-level metrics at 60-second granularity.

---

## Cost

Region: `eu-central-1` (primary) + `us-east-1` (secondary), 24/7, no traffic.

| Resource                                   | Idle            | ~N unit/month | Cost driver                     |
| ------------------------------------------ | --------------- | ------------- | ------------------------------- |
| Primary writer (t4g.medium, eu-central-1)  | ~$59/mo         | 720 hr        | Instance-hours                  |
| Secondary instance (t4g.medium, us-east-1) | ~$52/mo         | 720 hr        | Instance-hours                  |
| Aurora storage (per cluster)               | ~$0.10/GB-month | depends       | Usually minimal for demo        |
| Cross-region replication data transfer     | ~$0.02/GB       | depends       | Outbound from eu-central-1      |
| SSM bastion × 2 (t4g.nano)                 | ~$6/mo total    | —             | Instance-hours                  |
| VPC × 2                                    | ~$0             | —             | No NAT Gateways (natGateways=0) |

**Total idle: ~$120/mo**. Deploy, run the demo, and destroy to minimize cost. Aurora does not support stop/start on global database clusters.

---

## Notes

### Why all L1 constructs for the secondary cluster?

CDK's L2 `DatabaseCluster` always generates `masterUsername` and `masterUserPassword`. Secondary clusters in a global database must **not** specify these — they are inherited from the primary. CloudFormation rejects the request if they are present. Until [aws-cdk #29880](https://github.com/aws/aws-cdk/issues/29880) is resolved, use `CfnDBCluster` + `CfnDBInstance` directly for the secondary.

### Write Forwarding

Write forwarding is explicitly disabled (`enableGlobalWriteForwarding: false` in `stack_secondary.ts`). When enabled, the secondary cluster accepts DML writes (INSERT/UPDATE/DELETE) and forwards them to the primary over the replication channel.

**Consistency modes** (parameter `apg_write_forward.consistency_mode`):

- `SESSION` (default) — reads in the same session see their own forwarded writes
- `EVENTUAL` — no consistency wait; lowest latency; reads may be stale
- `GLOBAL` — waits until the secondary catches up to the primary's commit point

**Latency**: forwarded writes add ~44% overhead vs direct writes (cross-region round-trip to eu-central-1). Best for light, infrequent writes from us-east-1 applications.

**Limitations**: no DDL, no SERIALIZABLE isolation, no stored procedures, no TRUNCATE/VACUUM/LOCK TABLE. Connects via the secondary's **reader** endpoint (not the writer endpoint).

To enable: set `enableGlobalWriteForwarding: true` in `stack_secondary.ts` and redeploy `RdsAuroraGlobalSecondary`.

### Managed Switchover vs Unplanned Failover

|          | Switchover                                        | Failover                                    |
| -------- | ------------------------------------------------- | ------------------------------------------- |
| Use case | Planned maintenance, follow-the-sun               | Disaster recovery                           |
| RPO      | **Zero** (syncs before switching)                 | Non-zero (seconds)                          |
| CLI      | `switchover-global-cluster` (from primary region) | `failover-global-cluster --allow-data-loss` |
| Duration | ~1–2 minutes                                      | ~1 minute                                   |

Both operations preserve the topology — the old primary becomes a new secondary automatically.

### RPO Enforcement

The `rds.global_db_rpo` parameter allows blocking commits on the primary if all secondaries fall behind by more than N seconds. **Do not enable this in a 2-region setup** — if the primary region experiences an outage and the parameter is active on the secondary, it may block transactions after promotion. Leave it at the default (-1 = disabled).

---

## Commands to Play with the Stack

### Prerequisites

Bootstrap us-east-1 (one-time per account):

```bash
npx cdk bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/eu-west-1
```

### Deploy

```bash
npx cdk deploy SsmBastion VpcSubnetsSecondaryRegion SsmBastionSecondaryRegion
npx cdk deploy RdsAuroraGlobalPrimary RdsAuroraGlobalSecondary
```

### Set Up SSM Tunnels (two terminals)

**Terminal 1 — primary writer (eu-central-1):**

```bash
PRIMARY_BASTION=$(aws cloudformation describe-stacks --stack-name SsmBastion \
  --query 'Stacks[0].Outputs[?OutputKey==`BastionInstanceId`].OutputValue' --output text)
PRIMARY_WRITER=$(aws cloudformation describe-stacks --stack-name RdsAuroraGlobalPrimary \
  --query 'Stacks[0].Outputs[?OutputKey==`WriterEndpoint`].OutputValue' --output text)

aws ssm start-session --target $PRIMARY_BASTION \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "{\"host\":[\"$PRIMARY_WRITER\"],\"portNumber\":[\"5432\"],\"localPortNumber\":[\"5432\"]}"
```

**Terminal 2 — secondary reader (us-east-1):**

```bash
SECONDARY_BASTION=$(aws cloudformation describe-stacks --stack-name SsmBastionSecondaryRegion \
  --region eu-west-1 \
  --query 'Stacks[0].Outputs[?OutputKey==`BastionInstanceId`].OutputValue' --output text)
SECONDARY_READER=$(aws cloudformation describe-stacks --stack-name RdsAuroraGlobalSecondary \
  --region eu-west-1 \
  --query 'Stacks[0].Outputs[?OutputKey==`ReaderEndpoint`].OutputValue' --output text)

aws ssm start-session --target $SECONDARY_BASTION \
  --region eu-west-1 \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "{\"host\":[\"$SECONDARY_READER\"],\"portNumber\":[\"5432\"],\"localPortNumber\":[\"5433\"]}"
```

### Start Demo Server

```bash
AWS_REGION=eu-central-1 npx ts-node patterns/rds/demo_server.ts rds-aurora-global
```

### Interact

```bash
# Write a quote (hits primary writer via port 5432)
curl -s -X POST http://localhost:3000/quotes \
  -H 'Content-Type: application/json' \
  -d '{"text":"All replication is eventual.","author":"CAP Theorem"}' | jq

# Read quotes (hits secondary reader via port 5433)
curl -s http://localhost:3000/quotes | jq

# Write-read test: writes via primary, immediately reads via secondary.
# 'replicated: true' shows the secondary caught up within milliseconds.
curl -s http://localhost:3000/write-read-test | jq

# Health check (shows both pool stats)
curl -s http://localhost:3000/health | jq
```

### Destroy (secondary first)

```bash
npx cdk destroy RdsAuroraGlobalSecondary RdsAuroraGlobalPrimary SsmBastion SsmBastionSecondaryRegion VpcSubnetsSecondaryRegion
```

### Capture CloudFormation YAML

```bash
npx cdk synth RdsAuroraGlobalPrimary > patterns/rds/rds-aurora-global/cloud_formation_primary.yaml
npx cdk synth RdsAuroraGlobalSecondary > patterns/rds/rds-aurora-global/cloud_formation_secondary.yaml
```

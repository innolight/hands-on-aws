# opensearch-provisioned

## Pattern Description

```
curl / browser
       |  HTTP :3000
       v
 Express + OpenSearch Client (SigV4-signed)
       |  HTTPS to localhost:8443
       v
 ~~~~~~ SSM Port-Forward Tunnel ~~~~~~
       |  SSM session (HTTPS)
       v
 EC2 Bastion (Session Manager)
       |  HTTPS :443
       v
 OpenSearch Domain [SG: bastion→443]
   (2x t3.small, 2 AZ, gp3)
```

Components:
- **[OpenSearch Service (provisioned)](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/what-is.html)** — self-managed cluster with explicit node types, counts, and EBS storage. You control capacity; billing is per-instance-hour + EBS volume.
- **[Domain security group](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/vpc.html)** — controls network access to the domain's ENIs inside the VPC. Consumer stacks add ingress rules via `CfnSecurityGroupIngress`.
- **[IAM resource policy](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/ac.html#ac-types-resource)** — domain access policy granting `es:*` to the deploying account's root.
- **[SSM bastion](../ssm-bastion/README.md)** — EC2 instance reachable via Session Manager for port forwarding — no SSH, no inbound rules.
- **[SigV4 signing](https://docs.aws.amazon.com/general/latest/gr/sigv4_signing.html)** — all requests signed with `service: 'es'`; provisioned domains use `'es'`, not `'aoss'` (Serverless).

Data flow:
1. Demo server signs each HTTP request with SigV4 (service `es`) using local AWS credentials
2. Request is sent to `https://localhost:8443` — the local end of the SSM tunnel
3. SSM forwards it to the OpenSearch domain endpoint inside the VPC
4. OpenSearch validates the SigV4 signature against the IAM resource policy and returns the response

## Cost

> Region: eu-central-1. Minimum config: 2x t3.small.search + 2x 10 GB gp3.

| Resource | Idle | ~10K docs/month | Cost driver |
|---|---|---|---|
| OpenSearch Domain (2x t3.small) | **~$35/mo** | ~$35/mo | Instance uptime |
| EBS gp3 (2x 10 GB) | ~$2/mo | ~$2/mo | Volume size |
| EC2 bastion (t4g.nano) | ~$3/mo | ~$3/mo | Instance uptime (shared) |
| **Total** | **~$40/mo** | **~$40/mo** | Data node instances dominate |

**~10x cheaper at idle than [OpenSearch Serverless](../opensearch-serverless/README.md)** (~$40/mo vs ~$356/mo) because provisioned billing is per-instance, while Serverless has a 2-OCU minimum ($0.48/hr) regardless of traffic.

## Notes

**IAM-only vs FGAC (Fine-Grained Access Control)**: This pattern uses IAM resource policies only — the deploying account root gets `es:*` on the domain. FGAC adds an internal user database and role mappings inside the domain, enabling: multi-tenant index isolation, per-field/per-document permissions, Cognito-based Dashboards login, and read-only vs read-write separation. Use FGAC when multiple identities need different access levels; IAM-only is simpler when a single app has full cluster access.

**Data nodes vs dedicated master nodes**: Data nodes store data and execute search/indexing. Dedicated master nodes manage cluster state only (shard allocation, index metadata, node membership). When to add dedicated masters: >10 data nodes, or Multi-AZ with Standby deployment. Always use an odd count (3) for quorum. This pattern uses 2 data nodes with no dedicated masters — sufficient for learning and small workloads.

**SigV4 service name**: Provisioned domains use `service: 'es'`. Serverless uses `service: 'aoss'`. Using the wrong service name produces a 403 with no helpful error message.

**Zone awareness**: Distributes primary and replica shards across 2 AZs. Requires at least 2 data nodes. If one AZ goes down, the surviving AZ has a complete copy of every shard.

**t3 burst nature**: t3 instances accumulate CPU credits when idle and spend them under load. Suitable for dev/learning with intermittent traffic. For sustained production workloads, use m6g (Graviton) which provides consistent performance without credit mechanics.

**gp3 vs gp2**: gp3 provides 3,000 baseline IOPS at any volume size. gp2 IOPS scale with size (3 IOPS/GB) — a 10 GB gp2 volume gets only 30 IOPS, far too low for a search workload. gp3 is the correct choice for small volumes.

**Encryption settings are immutable**: `enforceHttps`, `encryptionAtRest`, and `nodeToNodeEncryption` cannot be changed after domain creation. You must delete and recreate the domain to change them.

**Automated daily snapshots**: AWS takes a free daily snapshot to S3 (14-day retention). No configuration needed. For on-demand snapshots with custom retention, register your own S3 bucket.

**Domain creation time**: Provisioned domains take 15-20 minutes to deploy (vs 3-5 minutes for AOSS collections). CloudFormation waits for the domain to reach `Active` status.

**`removalPolicy: DESTROY`** — non-production convenience. Data is deleted when the stack is destroyed.

## Commands

### Deploy

```bash
# VpcSubnets and SsmBastion must be deployed first
npx cdk deploy VpcSubnets SsmBastion OpenSearchProvisioned OpenSearchProvisionedApp
```

Domain creation takes 15-20 minutes. Wait for the stack to complete before proceeding.

### SSM Port Forward

[Install the SSM Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/install-plugin-macos-overview.html) if you haven't already.

```bash
# Fetch stack outputs
BASTION=$(aws cloudformation describe-stacks --stack-name SsmBastion \
  --query "Stacks[0].Outputs[?OutputKey=='BastionInstanceId'].OutputValue" --output text)
# Strip https:// — the bastion resolves this hostname inside the VPC.
HOST=$(aws cloudformation describe-stacks --stack-name OpenSearchProvisioned \
  --query "Stacks[0].Outputs[?OutputKey=='DomainEndpoint'].OutputValue" --output text \
  | sed 's|https://||')

# Start tunnel — keep this terminal open
aws ssm start-session \
  --target "$BASTION" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "{\"host\":[\"${HOST}\"],\"portNumber\":[\"443\"],\"localPortNumber\":[\"8443\"]}"
```

### Run Demo Server

In a new terminal (keep the tunnel running):

```bash
AWS_REGION=eu-central-1 npx ts-node patterns/opensearch-provisioned/demo_server.ts
```

### Interact

**Create index** (run once before indexing):
```bash
curl -s -X PUT http://localhost:3000/index | jq
```

**Index a product:**
```bash
curl -s -X POST http://localhost:3000/products \
  -H 'Content-Type: application/json' \
  -d '{"id":"p1","name":"Wireless Headphones","description":"Noise-cancelling over-ear headphones with 30h battery","category":"electronics","price":149.99,"inStock":true}' | jq
```

**Bulk index products:**
```bash
curl -s -X POST http://localhost:3000/products/_bulk \
  -H 'Content-Type: application/json' \
  -d '[
    {"id":"p2","name":"Running Shoes","description":"Lightweight trail running shoes","category":"footwear","price":89.99,"inStock":true},
    {"id":"p3","name":"Coffee Grinder","description":"Burr grinder for espresso and filter coffee","category":"kitchen","price":59.99,"inStock":false},
    {"id":"p4","name":"Mechanical Keyboard","description":"TKL layout, Cherry MX switches","category":"electronics","price":119.99,"inStock":true}
  ]' | jq
```

Wait ~1s for the refresh before searching (provisioned default refresh_interval is 1s, vs ~10s for AOSS).

**Full-text search:**
```bash
curl -s "http://localhost:3000/search?q=coffee" | jq
curl -s "http://localhost:3000/search?q=headphones&limit=5" | jq

# Paginate — pass next_search_after from the previous response
curl -s "http://localhost:3000/search?q=&limit=2&search_after=%5B1.0%2C%22p1%22%5D" | jq
```

**Advanced search with filters and aggregations:**
```bash
# Electronics under $130, in stock
curl -s "http://localhost:3000/search/advanced?category=electronics&maxPrice=130&inStock=true" | jq

# Full-text + price range
curl -s "http://localhost:3000/search/advanced?q=grinder&minPrice=40&maxPrice=100" | jq
```

**Get by ID:**
```bash
curl -s http://localhost:3000/products/p1 | jq
```

**Delete a document:**
```bash
curl -s -X DELETE http://localhost:3000/products/p1 | jq
```

**Delete index:**
```bash
curl -s -X DELETE http://localhost:3000/index | jq
```

### Observe

```bash
# Domain status
aws opensearch describe-domain --domain-name $(aws cloudformation describe-stacks \
  --stack-name OpenSearchProvisioned \
  --query "Stacks[0].Outputs[?OutputKey=='DomainName'].OutputValue" --output text) \
  --query 'DomainStatus.Processing' --output text
```

### Synthesize CloudFormation

```bash
npx cdk synth OpenSearchProvisioned > patterns/opensearch-provisioned/cloud_formation.yaml
npx cdk synth OpenSearchProvisionedApp > patterns/opensearch-provisioned/cloud_formation_app.yaml
```

### Destroy

```bash
npx cdk destroy OpenSearchProvisionedApp OpenSearchProvisioned
```

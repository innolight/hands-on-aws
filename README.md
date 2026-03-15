# AWS Patterns

In this project, I try to gain deep and hands-on knowledge of architecting application in AWS by using CDK to implement
popular architectural patterns in AWS.

## Patterns

Discover AWS patterns in folder [patterns](./patterns):

Datastore / S3:
- [x] [`s3-polished-configuration`](./patterns/s3-polished-configuration): S3 with encryption, versioning enabled, lifecycle rule, data archiver with Glacier
- [x] [`s3-events-notification`](./patterns/s3-events-notification): S3 → SNS → SQS → SQS (DLQ) 
- [x] [`s3-cross-region-replication`](./patterns/s3-cross-region-replication): S3 → S3 (another region); Multi-region Access Point for S3
- [x] [`s3-static-website-cloudfront`](./patterns/s3-static-website-cloudfront): S3 hosting a HTTPS static website, using CloudFront for global delivery
- [x] [`s3-lambda-rekognition-dynamodb`](./patterns/s3-lambda-rekognition-dynamodb): image processing pipeline and metadata storage
- [x] [`s3-behind-sftp`](./patterns/s3-behind-sftp/): SFTP access to S3 using AWS Transfer 
- [x] [`s3-vectors-bucket`](./patterns/s3-vectors-bucket/): S3 Vector Bucket + Index for similarity search on food reviews
- [ ] `s3-serverless-data-lake`: S3 (Storage) → AWS Glue (Data Catalog/Crawler) → Amazon Athena (Query Engine)

Datastore / Dynamodb:
- [x] [`dynamodb-global-database`](./patterns/dynamodb-global-database/): Dynamodb Global Database (multi-write architecture)
- [x] [`dynamodb-stream-lambda`](./patterns/dynamodb-stream-lambda): Dynamodb → Dynamodb Stream → Lambda
- [ ] `dynamodb-to-s3-zero-etl`: Dynamodb → S3 with Zero-ETL
- [ ] `dynamodb-kinesis-opensearch`: Dynamodb → Dynamodb Stream → Kinesis Stream → Kinesis Data Firehose → S3 | AWS OpenSearch

Datastore / Elasticache:
- [x] [`elasticache-valkey-active-passive`](./patterns/elasticache-valkey-active-passive): ElastiCache Valkey replication group (1 primary + N replicas), RBAC, TLS, SSM port forwarding via ssm-bastion
- [x] [`elasticache-valkey-cluster`](./patterns/elasticache-valkey-cluster): ElastiCache Valkey cluster mode (N shards × M replicas), hash-slot distribution  with consistent hashing
- [x] [`elasticache-valkey-serverless`](./patterns/elasticache-valkey-serverless): ElastiCache Valkey Serverless (auto-scaling, ECPU billing, no capacity planning), retry backoff + jitter, command pipelining


Datastore / RDS & Aurora:
- [ ] `rds-backup-and-recovery`: Set up automated backups and point-in-time recovery for RDS
- [ ] `rds-readable-standbys`: Multi-AZ deployment of RDS with 2 readable standby instance
- [ ] `rds-aurora-cross-region-replication`: RDS Aurora Cross-Region replication + Write Forwarding
- [ ] `rds-aurora-serverless-v2`: Deploying Aurora Serverless v2 with autoscaling
- [ ] `rds-proxy`: RDS proxy in front of RDS

Datastore / OpenSearch:
- [ ] TBD

Infrastructures / Containers on AWS:
- [ ] [`elastic-container-registry`](./patterns/containers/elastic-container-registry): ECR repository provisioning, Docker image build & push
- [ ] [`app-runner`](./patterns/containers/app-runner): App Runner — fully managed, source-to-URL container hosting
- [ ] [`ecs-fargate-alb`](./patterns/containers/ecs-fargate-alb): ECS Fargate + ALB — serverless containers behind Application Load Balancer
- [ ] [`ecs-fargate-apigw`](./patterns/containers/ecs-fargate-apigw): ECS Fargate + API Gateway HTTP API + VPC Link
- [ ] [`ecs-ec2-alb`](./patterns/containers/ecs-ec2-alb): ECS on EC2 (Spot) + ALB — self-managed container instances behind load balancer
- [ ] [`lambda-container`](./patterns/containers/lambda-container): Lambda container image + Function URL — serverless per-request execution
- [ ] [`one-ec2`](./patterns/containers/one-ec2): Single EC2 instance running Docker, public-facing
- [ ] [`ec2s-behind-alb`](./patterns/containers/ec2s-behind-alb): Auto Scaling Group of EC2s running Docker behind ALB
- [ ] [`eks-fargate`](./patterns/containers/eks-fargate): EKS Fargate — Kubernetes control plane + serverless pods, no node management

Infrastructures:
- [x] [`vpc-subnets`](./patterns/vpc-subnets): VPC with 3-tier subnet layout (public / private / isolated) across 3 AZs, configurable NAT Gateways
- [x] [`ssm-bastion`](./patterns/ssm-bastion): EC2 bastion accessible via SSM Session Manager (no SSH, no inbound rules) — used for port forwarding to isolated resources
- [ ] `event-bridge-lambda-job`: Lightweight job with event bridge triggering lambda function using cron schedule  
- [ ] `msk-lambda`: Kafka cluster setup via Amazon Managed Streaming for Kafka (MSK), Lambda consumer
- [ ] `waf-shield-ddos-protection`: AWS WAF + Shield for DDoS protection on CloudFront
- [ ] `sagemaker-pipeline`: Building an end-to-end ML pipeline with AWS SageMaker and CDK
- [ ] `glue-etl-job`: AWS Glue ETL job that processes and transforms data in S3 to different format

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [pnpm](https://pnpm.io/) package manager
- AWS CLI configured with valid credentials (`aws configure`)
- AWS CDK CLI (included via `npx cdk`)

### Getting Started

```bash
pnpm install
```

CDK automatically resolves `CDK_DEFAULT_ACCOUNT` and `CDK_DEFAULT_REGION` from your AWS CLI profile (`aws configure`). To target a specific region:

```bash
export CDK_DEFAULT_REGION=eu-central-1
```

### CDK Construct Levels

CDK organizes cloud resources into three levels of abstraction called **constructs**:

| Level | Name | What it is | Example |
|---|---|---|---|
| **L1** | CFN Resources | 1:1 mapping to CloudFormation resources. Prefixed with `Cfn`. No defaults — you configure every property yourself. | `CfnBucket`, `CfnFunction` |
| **L2** | Curated Constructs | AWS-vetted wrappers around L1. Provide sensible defaults, helper methods (e.g., `bucket.grantRead(lambda)`), and a higher-level API. Most of what you'll use day-to-day. | `s3.Bucket`, `lambda.Function` |
| **L3** | Patterns | Opinionated multi-resource compositions. Wire together several L2 constructs into a common architecture. | `LambdaRestApi` (API Gateway + Lambda), `S3BucketDeployment` (S3 + Lambda + Custom Resource) |

**When to use which:**
- **Start with L2** — covers ~90% of cases with good defaults and grant helpers that auto-generate least-privilege IAM policies.
- **Drop to L1** when you need a property that L2 doesn't expose yet (use `node.defaultChild` to escape-hatch from L2 to L1).
- **Use L3** when a well-known pattern exists and you don't need to customize the wiring between resources.

### Project Structure

```
bin/cdk.ts                        # Entry point — registers all CDK stacks
patterns/<name>/
  ├── stack.ts                    # CDK Stack class (or stack_step*.ts for multi-step patterns)
  ├── README.md                   # Pattern-specific notes
  ├── cloud_formation.yaml        # Synthesized CloudFormation output
  ├── demo_server.ts              # (Optional) Express server to demo the pattern
  └── demo_requests.http          # (Optional) HTTP requests for the demo server
utils/
  └── stackoutput.ts              # getStackOutputs(stackName) — discovers deployed resources at runtime
```

### CDK Workflow

**Stage 1 — Environment setup (once per account/region)**

- `npx cdk bootstrap` — provisions the S3 bucket and IAM resources CDK needs to store assets (Lambda packages, templates) during deployment. Run once per AWS account + region before first deploy.

**Stage 2 — Development**

- `npx cdk ls` — list all stacks defined in the app; confirms the code compiles and shows what's available to deploy.
- `npx cdk synth <StackName>` — compile your CDK code into a CloudFormation template (written to `cdk.out/`). Use this to inspect what will actually be deployed or catch errors early.

**Stage 3 — Review**

- `npx cdk diff <StackName>` — compare your local code against what's currently deployed. Like `git diff` for infrastructure — always run this before deploying to see exactly what will be added, changed, or deleted.

**Stage 4 — Deploy**

- `npx cdk deploy <StackName>` — upload assets to the bootstrap bucket and apply the CloudFormation template to your AWS account.

**Stage 5 — Teardown**

- `npx cdk destroy <StackName>` — delete the CloudFormation stack and all resources within it. Prompts for confirmation before deleting.

> **Note:** All patterns use `removalPolicy: DESTROY` and `autoDeleteObjects: true` for easy cleanup. These settings are **not production-safe**.

### Adding a New Pattern

1. Create `patterns/<name>/stack.ts` — extend `cdk.Stack`, export a stack name constant, and use `CfnOutput` for key resource IDs/ARNs
2. Register the stack in `bin/cdk.ts`
3. (Optional) Add `demo_server.ts` using `getStackOutputs()` to discover resources at runtime
4. Add a `README.md` in the pattern folder
5. Synthesize the template: `npx cdk synth <StackName> > patterns/<name>/cloud_formation.yaml`

### Running Demo Servers

```bash
AWS_REGION=eu-central-1 npx ts-node patterns/<name>/demo_server.ts
```

Demo servers use `getStackOutputs()` from `utils/stackoutput.ts` to discover deployed resource names and ARNs at runtime — no hardcoding needed. Deploy the pattern stack first, then start the server.

### Useful Commands

| Command | Description |
|---|---|
| `pnpm run build` | Compile TypeScript to JS |
| `pnpm run watch` | Watch for changes and compile |
| `pnpm run test` | Run Jest unit tests |
| `npx cdk synth` | Emit synthesized CloudFormation template |
| `npx cdk diff` | Compare deployed stack with current state |
| `npx cdk deploy` | Deploy stack to your default AWS account/region |
| `npx cdk destroy` | Tear down a deployed stack |

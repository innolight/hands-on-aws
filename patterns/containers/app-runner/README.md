# app-runner

Runs the Express container on [AWS App Runner](https://docs.aws.amazon.com/apprunner/latest/dg/what-is-apprunner.html) — the lowest-ops container option: no VPC, no ALB, no cluster to manage.

## Pattern Description

```
Client
  │ HTTPS (App Runner-managed TLS)
  ▼
App Runner Service
  │ port 3000
  ▼
Express container (:latest from ECR)
  │ SSM GetParameters (API_KEY injected at startup)
  ▼
SSM Parameter Store
```

- [App Runner Service](https://docs.aws.amazon.com/apprunner/latest/dg/manage-create.html) — pulls the image from ECR, manages TLS termination, load balancing, and auto-scaling automatically; no cluster or ALB needed
- [ECR image](https://docs.aws.amazon.com/AmazonECR/latest/userguide/Repositories.html) — `hands-on-containers:latest` (x86_64/amd64 manifest from the multi-arch push); created by the `elastic-container-registry` pattern
- [SSM SecureString](https://docs.aws.amazon.com/systems-manager/latest/userguide/systems-manager-parameter-store.html) — `API_KEY` fetched at container startup via `runtimeEnvironmentSecrets`; injected as an env var, never appears in the CloudFormation template
- Access Role — trusted by `build.apprunner.amazonaws.com`; grants `AmazonEC2ContainerRegistryReadOnly` so App Runner can pull the image at deploy time
- Instance Role — trusted by `tasks.apprunner.amazonaws.com`; grants `ssm:GetParameters` on the specific parameter ARN for runtime secret injection

## Cost

Region: eu-central-1 — 1 instance, low request volume

| Resource | Idle | ~1k req/day | Cost driver |
|---|---|---|---|
| App Runner provisioned instance | ~$2.50/mo | ~$2.50/mo | Memory: $0.007/GB-hr × 0.5 GB × 720 hr |
| App Runner active compute | $0 | ~$0.01/mo | $0.064/vCPU-hr, billed only while handling requests |
| CloudWatch logs | ~$0 | ~$0 | $0.57/GB ingested; tiny log volume |

Dominant cost: provisioned instance memory (~$2.50/mo). No true scale-to-zero — one instance stays warm at all times. Manual pause stops billing entirely, but the service becomes unavailable.

## Notes

The tradeoff with App Runner is simplicity vs control. You get managed TLS, load balancing, and auto-scaling with zero VPC/ALB/cluster config — but you lose scale-to-zero, ARM64 support, task placement control, and blue/green deployments.

- **Rolling deployment only** — App Runner has one deployment strategy: rolling. New instances start with the new image, health checks run, traffic shifts, old instances drain. No blue/green, no canary. If health checks fail, the deployment rolls back automatically
- **Deployment triggers** — two options: (1) `autoDeploymentsEnabled: true`: App Runner watches ECR and deploys on every push — zero-touch but no manual gate; (2) `autoDeploymentsEnabled: false` (this stack): push image, then explicitly trigger via Console or `aws apprunner start-deployment` — full control over when deployments happen
- **No VPC, no ALB** — App Runner handles all networking; the simplest container pattern in this repo
- **ARM64 not supported yet - x86_64 only** — App Runner does not support ARM64; the ECR image must include a `linux/amd64` manifest (the multi-arch build in `elastic-container-registry` covers this).
- **No true scale-to-zero** — the minimum instance count is 1 (minSize >= 1); a provisioned instance is always warm. Use Lambda container for true zero-cost idle
- **`runtimeEnvironmentSecrets`** — App Runner fetches the SSM value at container startup using the Instance Role, not at CloudFormation deploy time; rotating the SSM parameter requires a new deployment to take effect
- **Log retention** — App Runner auto-creates log groups; retention defaults to never-expire. Three options to set it: (1) manually via `aws logs put-retention-policy` after deploy; (2) `logs.LogRetention` CDK construct using `service.attrServiceId` to construct the group name — it's a Lambda-backed custom resource that runs at deploy time when the ID is known; (3) an EventBridge rule on `CreateLogGroup` events invoking a Lambda to set retention on any new log group matching the prefix — useful as an account-wide policy

## Commands

**1. Prerequisites**

Deploy the ECR stack and push a multi-arch image first:

```bash
npx cdk deploy ElasticContainerRegistryStack
./patterns/containers/elastic-container-registry/build_and_push.sh

# Create the API key in SSM (if not already done)
aws ssm put-parameter \
  --name /hands-on-aws/containers/api-key \
  --type SecureString \
  --value "$(openssl rand -hex 16)"
```

**2. Deploy**

```bash
npx cdk deploy AppRunnerStack
```

**3. Interact**

```bash
# Get the service URL from stack outputs
SERVICE_URL=$(aws cloudformation describe-stacks \
  --stack-name AppRunnerStack \
  --query "Stacks[0].Outputs[?OutputKey=='ServiceUrl'].OutputValue" \
  --output text | tr -d '\r')

# Health check (no auth required)
curl "${SERVICE_URL}/health"

# Quote endpoint (API key required)
API_KEY=$(aws ssm get-parameter \
  --name /hands-on-aws/containers/api-key \
  --with-decryption \
  --query Parameter.Value \
  --output text)
curl -H "x-api-key: ${API_KEY}" "${SERVICE_URL}/quote"
```

**4. Observe logs**

```bash
# App Runner creates log groups under /aws/apprunner/<service-name>/<service-id>/.
# The service-id suffix is unknown until after first deploy — list to find the exact names:
aws logs describe-log-groups --log-group-name-prefix /aws/apprunner/app-runner-container \
  --query 'logGroups[].logGroupName' --output text --no-cli-pager

# Tail application logs (your Express server stdout/stderr)
aws logs tail --follow /aws/apprunner/app-runner-container/<service-id>/application 

# Tail service logs (App Runner system events: deployments, health checks, scaling)
aws logs tail --follow /aws/apprunner/app-runner-container/<service-id>/service
```

**5. Trigger a new deployment (after pushing a new image)**

```bash
SERVICE_ARN=$(aws apprunner list-services \
  --query "ServiceSummaryList[?ServiceName=='app-runner-container'].ServiceArn" \
  --output text)
aws apprunner start-deployment --service-arn "${SERVICE_ARN}"
```

**6. Destroy**

```bash
npx cdk destroy AppRunnerStack
```

**7. Capture CloudFormation template**

```bash
npx cdk synth AppRunnerStack > patterns/containers/app-runner/cloud_formation.yaml
```

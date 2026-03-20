# ecs-fargate-alb

Runs the shared Express API on ECS Fargate, exposed via an internet-facing Application Load Balancer with path-based routing — simpler than the API GW + VPC Link path at the cost of a higher idle price.

## Pattern Description

```
Client
  │ HTTP GET /quote-service/quote
  ▼
ALB  (internet-facing, public subnets)
  │ Listener :80
  │   ├── /quote-service, /quote-service/*  → Target Group (priority 100)
  │   └── default                           → 404 "Not Found"
  │
  ▼
ECS Fargate Task  (private subnet, port 3000)
  │  ROUTE_PREFIX=/quote-service
  │
  ├── ECR image          (from ElasticContainerRegistryStack)
  └── API_KEY env var    (from SSM SecureString via task definition secrets)
```

- [Application Load Balancer](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/introduction.html) — Layer 7 load balancer; health-checks tasks and routes HTTP traffic; ~$20/mo idle
- [ALB Listener Rules](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-update-rules.html) — path-based routing sends `/quote-service/*` to this service's target group; unmatched paths get a 404 fixed response
- [ECS Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html) — serverless compute for containers; tasks run in private subnets and register their IPs directly with the ALB target group
- [ALB Target Group](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-target-groups.html) — tracks healthy Fargate task IPs; ECS deregisters tasks on scale-in before the drain timeout expires

## Cost

Region: eu-central-1 — 1 task running 24/7, ~10k requests/month

| Resource | Idle | ~10k req/month | Cost driver |
|---|---|---|---|
| Fargate (256 CPU / 512 MB) | ~$9/mo | ~$9/mo | $0.04048/vCPU·hr + $0.004445/GB·hr |
| ALB | ~$20/mo | ~$20/mo | $0.008/LCU·hr + $0.028/hr fixed |
| CloudWatch Logs | ~$0.50/mo | ~$0.50/mo | Ingestion cost |
| **Total** | **~$30/mo** | **~$30/mo** | ALB fixed cost dominates |

The ALB costs ~$20/mo regardless of traffic — roughly 2× more expensive than the API GW + VPC Link approach at low request volumes. The tradeoff: ALB handles WebSocket, gRPC, and sticky sessions which API Gateway HTTP API does not.

## Notes

**Stack split: networking → compute**

The networking stack exports `listener`. Each service stack (compute) creates its own target group + listener rule + registers tasks. This lets you add more services behind the same ALB by creating additional compute stacks with different path prefixes and listener rule priorities.

**Listener default action: 404**

Unmatched paths return `404 Not Found` instead of forwarding to a random service. Each service adds an `ApplicationListenerRule` with a path condition (e.g. `/quote-service/*` at priority 100). New services pick a different priority (200, 300, etc.).

**ALB does not rewrite paths**

A request to `/quote-service/health` is forwarded as `/quote-service/health` to the container. The Express app uses `ROUTE_PREFIX=/quote-service` env var to mount its router under the prefix. Without `ROUTE_PREFIX`, routes stay at `/health` and `/quote` (backward-compatible with other patterns).

**SG ingress via CDK Connections tracking**

`attachToApplicationTargetGroup` + the `ApplicationListenerRule` linking the target group to the listener gives CDK enough information to auto-generate a `SecurityGroupIngress` rule (ALB SG → task SG, port 3000).

**ALB target group deregistration delay**

Set to 30s (down from the ALB default of 300s). For short-lived Express responses, tasks finish in-flight requests quickly — a 5-minute drain window just delays scale-in.

**ECR image pull from private subnets**

Tasks run in private subnets and need outbound internet access to pull from ECR and fetch SSM parameters. Deploy the VPC stack with `-c natGateways=1`, or use VPC Interface Endpoints for `ecr.api`, `ecr.dkr`, and `ssm`.

## Commands

**1. Prerequisites — ECR image and SSM API key must exist**

```bash
# See elastic-container-registry README for full steps
npx cdk deploy ElasticContainerRegistryStack
# push image, create SSM parameter...
```

**2. Deploy the stacks**

```bash
# VpcSubnets must be deployed with natGateways >= 1 so tasks can pull from ECR
npx cdk deploy -c natGateways=1 VpcSubnets EcsClusterStack EcsFargateAlbNetworkingStack EcsFargateAlbComputeStack
```

**3. Invoke the API**

```bash
# Get ALB endpoint http://<alb-dns>
ENDPOINT=$(aws cloudformation describe-stacks \
  --stack-name EcsFargateAlbNetworkingStack \
  --query "Stacks[0].Outputs[?OutputKey=='AlbEndpoint'].OutputValue" \
  --output text)

# Health check (unauthenticated)
curl "$ENDPOINT/quote-service/health"
# {"status":"ok"}

# Unmatched path returns 404
curl "$ENDPOINT/nonexistent"
# Not Found

# Read the API key from SSM
API_KEY=$(aws ssm get-parameter \
  --name /hands-on-aws/containers/api-key \
  --with-decryption \
  --query "Parameter.Value" \
  --output text)

# Quote with key
curl -H "x-api-key: $API_KEY" "$ENDPOINT/quote-service/quote"
```

**4. Observe logs**

```bash
aws logs tail /ecs/ecs-fargate-alb --follow
```

**5. Destroy**

```bash
npx cdk deploy VpcSubnets -c natGateways=0 # destroy NAT Gateway which drains money
npx cdk destroy EcsFargateAlbComputeStack EcsFargateAlbNetworkingStack
```

**6. Capture CloudFormation templates**

```bash
npx cdk synth EcsFargateAlbNetworkingStack > patterns/containers/ecs-fargate-alb/cloud_formation_networking.yaml
npx cdk synth EcsFargateAlbComputeStack > patterns/containers/ecs-fargate-alb/cloud_formation_compute.yaml
```

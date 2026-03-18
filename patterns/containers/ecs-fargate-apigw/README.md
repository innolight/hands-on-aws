# ecs-fargate-apigw

Runs the shared Express API on ECS Fargate, exposed via API Gateway HTTP API + VPC Link + Cloud Map — no load balancer required.

## Pattern Description

```
Client
  │ HTTPS
  ▼
API Gateway HTTP API  (public endpoint, managed TLS)
  │ VPC Link (private tunnel into VPC)
  ▼
Cloud Map (service discovery, SRV record per healthy task)
  │ TCP 3000
  ▼
ECS Fargate Task  (private subnet, port 3000)
  │
  ├── ECR image          (from ElasticContainerRegistryStack)
  └── API_KEY env var    (from SSM SecureString via task definition secrets)
```

- [API Gateway HTTP API](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api.html) — public HTTPS endpoint; ~$0 idle cost, $1/million requests
- [VPC Link](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-vpc-links.html) — private tunnel connecting API Gateway to resources inside the VPC without exposing them to the internet; no idle cost
- [Cloud Map](https://docs.aws.amazon.com/cloud-map/latest/dg/what-is-cloud-map.html) — service discovery registry; ECS registers each task's private IP and port as a SRV record; API Gateway queries Cloud Map at request time to find healthy targets
- [ECS Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html) — serverless compute for containers; no EC2 instances to manage; tasks run in private subnets

## Cost

Region: eu-central-1 — 1 task running 24/7, ~10k requests/month

| Resource | Idle | ~10k req/month | Cost driver |
|---|---|---|---|
| Fargate (256 CPU / 512 MB) | ~$9/mo | ~$9/mo | $0.04048/vCPU·hr + $0.004445/GB·hr |
| API Gateway HTTP API | $0 | ~$0.01 | $1/million requests |
| VPC Link | $0 | $0 | No per-link charge |
| Cloud Map (private DNS) | $0 | $0 | Private namespaces are free |
| CloudWatch Logs | ~$0.50/mo | ~$0.50/mo | Ingestion cost |
| **Total** | **~$10/mo\*** | **~$10/mo** | |

\* The ~$10/mo is the Fargate task. API GW + VPC Link + Cloud Map have no idle cost, so scale-to-zero is architecturally possible — see Notes.

## Notes

**Stack split: cluster → compute → networking**

This pattern uses three stacks. `EcsClusterStack` owns the ECS cluster and Cloud Map namespace — deployed once, shared across services. `EcsFargateComputeStack` owns the task definition, Fargate service, task SG, and auto-scaling — changes on every service deploy. `EcsFargateNetworkingStack` owns the VPC Link, HTTP API, routes, and the SG ingress rule — wired up last because it depends on both the Cloud Map service (from compute) and the task SG. The networking stack adds the ingress rule via L1 `CfnSecurityGroupIngress` rather than mutating the task SG directly, keeping cross-stack coupling explicit and unidirectional.



**Why Cloud Map instead of an ALB?**

API Gateway HTTP API supports two VPC Link integration targets: an internal ALB/NLB, or Cloud Map service discovery. Cloud Map avoids the ~$20/mo ALB cost and is sufficient for routing to a single service. With an ALB you'd get deterministic round-robin load balancing and path-based routing — worth it at scale, unnecessary here.

**Scale-to-zero**

This stack uses [Application Auto Scaling](https://docs.aws.amazon.com/autoscaling/application/userguide/what-is-application-auto-scaling.html) (0–3 tasks, CPU-based). API Gateway and VPC Link have no idle cost, so scaling to zero yields ~$0/mo at idle. The tradeoff: Fargate cold start is 30–90s; API Gateway returns 503 while no tasks are running.

**VPC Link security group chaining**

The VPC Link security group has no inbound rules — API Gateway manages ingress through the VPC Link ENIs. The task security group only accepts TCP 3000 from the VPC Link SG. This means the only path to the container is `API GW → VPC Link ENI → task`.

**ECR image pull from private subnets**

ECS tasks run in private subnets and need outbound internet access to pull from ECR and fetch SSM parameters. This requires either a NAT Gateway (`-c natGateways=1`) or VPC Interface Endpoints for `ecr.api`, `ecr.dkr`, and `ssm` (~$14/mo total vs ~$32/mo NAT). For production, VPC endpoints are preferred — no internet path for image pulls.

**Access logs for debugging**

VPC Link connectivity failures surface as `503 No target endpoints found` or `504 Endpoint request timed out`. API Gateway access logs (enabled in this stack) capture `integrationLatency` and `status` per request — the fastest way to diagnose routing issues.

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
npx cdk deploy -c natGateways=1 VpcSubnets EcsClusterStack EcsFargateComputeStack EcsFargateNetworkingStack
```

**3. Invoke the APIs**

```bash
# Get API GW endpoint https://<api-id>.execute-api.eu-central-1.amazonaws.com
ENDPOINT=$(aws cloudformation describe-stacks \
  --stack-name EcsFargateNetworkingStack \
  --query "Stacks[0].Outputs[?OutputKey=='ApiEndpoint'].OutputValue" \
  --output text)

# Health check (unauthenticated)
curl "$ENDPOINT/health"
# {"status":"ok"}

# Quote without key → 401
curl "$ENDPOINT/quote"
# Unauthorized

# Read the API key from SSM
API_KEY=$(aws ssm get-parameter \
  --name /hands-on-aws/containers/api-key \
  --with-decryption \
  --query "Parameter.Value" \
  --output text)

# Quote with key
curl -H "x-api-key: $API_KEY" "$ENDPOINT/quote"
```

**4. Observe logs**

```bash
# ECS container logs
aws logs tail /ecs/ecs-fargate-apigw --follow

# API Gateway access logs
aws logs tail /apigateway/ecs-fargate-apigw --follow
```

**5. Destroy**

```bash
npx cdk deploy VpcSubnets -c natGateways=0 # destroy NAT Gateway which drains money
npx cdk destroy EcsFargateNetworkingStack EcsFargateComputeStack EcsClusterStack
```

**7. Capture CloudFormation templates**

```bash
npx cdk synth EcsClusterStack > patterns/containers/ecs-fargate-apigw/cloud_formation_ecs_cluster.yaml
npx cdk synth EcsFargateComputeStack > patterns/containers/ecs-fargate-apigw/cloud_formation_compute.yaml
npx cdk synth EcsFargateNetworkingStack > patterns/containers/ecs-fargate-apigw/cloud_formation.yaml
```

# ec2s-behind-alb

ASG of Spot EC2 instances running Docker directly (no ECS) behind an internet-facing Application Load Balancer with path-based routing — highest ops burden, lowest abstraction.

## Pattern Description

```
Client
  │ HTTP GET /ec2s-alb/quote
  ▼
ALB  (internet-facing, public subnets)
  │ Listener :80
  │   ├── /ec2s-alb, /ec2s-alb/*  → Target Group (priority 200)
  │   └── default                  → 404 "Not Found"
  │
  ▼
EC2 instances  (private subnet, Spot, t4g.micro ARM64)
  │  Docker: --restart=always, --log-driver=awslogs
  │  ROUTE_PREFIX=/ec2s-alb
  │
  ├── ECR image          (from ElasticContainerRegistryStack)
  └── API_KEY env var    (from SSM SecureString via user data script)
```

- [Auto Scaling Group](https://docs.aws.amazon.com/autoscaling/ec2/userguide/auto-scaling-groups.html) — manages EC2 instance lifecycle; min=2, max=4 across AZs; Spot with `capacityRebalance` for proactive replacement
- [Spot Instances](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/using-spot-instances.html) — `PRICE_CAPACITY_OPTIMIZED` allocation picks pools with lowest interruption risk and price; ~60% savings over On-Demand
- [Application Load Balancer](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/introduction.html) — Layer 7 load balancer; health-checks instances on `/ec2s-alb/health`; routes HTTP traffic; ~$20/mo idle
- [Launch Template](https://docs.aws.amazon.com/autoscaling/ec2/userguide/launch-templates.html) — defines instance config: AMI, instance type, user data, IAM role, security group, IMDSv2
- [EC2 User Data](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/user-data.html) — shell script that runs on first boot: installs Docker, authenticates to ECR, pulls image, reads SSM parameter, starts container

## Cost

Region: eu-central-1 — 2 Spot t4g.micro instances running 24/7, ~10k requests/month

| Resource           | Idle        | ~10k req/month | Cost driver                                                |
| ------------------ | ----------- | -------------- | ---------------------------------------------------------- |
| Spot t4g.micro × 2 | ~$6/mo      | ~$6/mo         | ~$0.0038/hr per instance (Spot ~60% off $0.0096 On-Demand) |
| ALB                | ~$20/mo     | ~$20/mo        | $0.008/LCU·hr + $0.028/hr fixed                            |
| Self-managed NAT   | ~$3.40/mo   | ~$3.40/mo      | t4g.nano Spot instance                                     |
| CloudWatch Logs    | ~$0.50/mo   | ~$0.50/mo      | Ingestion cost                                             |
| **Total**          | **~$30/mo** | **~$30/mo**    | ALB fixed cost dominates                                   |

## Notes

**Stack split: networking → compute**

Same pattern as `ecs-fargate-alb`. The networking stack exports `listener`. The compute stack creates its own target group, listener rule (priority 200), and registers instances. Multiple services can share one ALB.

**No ECS — Docker installed via user data**

User data runs on first boot: `dnf install docker` → ECR login → `docker pull` → `docker run`. The `--restart=always` flag handles container crashes (Docker daemon restarts the container automatically). Boot time is ~2 minutes (package install + image pull).

**Spot instances and interruption handling**

- `capacityRebalance: true` — ASG proactively launches a replacement when AWS sends a rebalance recommendation, before the 2-minute interruption notice
- `PRICE_CAPACITY_OPTIMIZED` — picks Spot pools with both low price and low interruption probability
- ALB drain (30s deregistration delay) + Docker SIGTERM give the container time to finish in-flight requests
- min=2 ensures at least one instance is healthy while the other is being replaced

**INSTANCE target type vs IP (Fargate)**

EC2-backed ASGs register by instance ID + port. Fargate uses IP target type because tasks register their ENI IP directly. Using INSTANCE here lets the ASG handle registration/deregistration automatically.

**IMDSv2 required**

`httpTokens: REQUIRED` on the launch template enforces IMDSv2 (token-based). Prevents SSRF attacks from stealing instance metadata credentials via the `169.254.169.254` endpoint.

**SSM Session Manager for debugging (no SSH)**

No SSH key pairs or port 22 ingress. Debug via SSM:

```bash
# Find an instance ID
INSTANCE_ID=$(aws autoscaling describe-auto-scaling-groups \
  --query "AutoScalingGroups[?contains(AutoScalingGroupName,'Ec2sAlb')].Instances[0].InstanceId" \
  --output text)

# Shell into the instance
aws ssm start-session --target $INSTANCE_ID

# Inside the instance:
docker ps
docker logs api
```

**Path prefix `/ec2s-alb`**

ALB does not rewrite paths — the container receives `/ec2s-alb/health` as-is. The Express app uses `ROUTE_PREFIX=/ec2s-alb` to mount its router under the prefix.

## Commands

**1. Prerequisites — ECR image and SSM API key must exist**

```bash
# See elastic-container-registry README for full steps
npx cdk deploy ElasticContainerRegistryStack
# push image, create SSM parameter...
```

**2. Deploy the stacks**

```bash
# VpcSubnets must be deployed with natGateways >= 1 so instances can pull from ECR
npx cdk deploy -c natGateways=1 VpcSubnets Ec2sAlbNetworkingStack Ec2sAlbComputeStack
```

**3. Invoke the API**

```bash
# Get ALB endpoint http://<alb-dns>
ENDPOINT=$(aws cloudformation describe-stacks \
  --stack-name Ec2sAlbNetworkingStack \
  --query "Stacks[0].Outputs[?OutputKey=='AlbEndpoint'].OutputValue" \
  --output text)

# Health check (unauthenticated)
curl "$ENDPOINT/ec2s-alb/health"
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
curl -H "x-api-key: $API_KEY" "$ENDPOINT/ec2s-alb/quote"
```

**4. Observe logs**

```bash
aws logs tail /ec2/ec2s-behind-alb --follow
```

**5. Destroy**

```bash
npx cdk deploy VpcSubnets -c natGateways=0  # destroy NAT instance which drains money
npx cdk destroy Ec2sAlbComputeStack Ec2sAlbNetworkingStack --force
```

**6. Capture CloudFormation templates**

```bash
npx cdk synth Ec2sAlbNetworkingStack > patterns/containers/ec2s-behind-alb/cloud_formation_networking.yaml
npx cdk synth Ec2sAlbComputeStack > patterns/containers/ec2s-behind-alb/cloud_formation_compute.yaml
```

# Containers on AWS

Multiple ways to run the same containerized API on AWS — each pattern showcases a different compute and networking model, from single EC2 instance to managed Kubernetes.

Based on the logic from the video, here is the decision tree for deploying containers on AWS structured as a hierarchy.

### **AWS Container Deployment Decision Tree**

Considered the decision three belows for choosing which navigating options

**Are you using Kubernetes?**
* **YES** ➔ **[Amazon EKS]** (Elastic Kubernetes Service)
* **NO** ➔ **Do you want Serverless or Provisioned infrastructure?**
    * **Option A: Serverless (AWS manages the servers)**
        * Are your invocations < 15 minutes?
            * **YES** ➔ **[AWS Lambda]** (Event-driven, pay-per-use)
            * **NO** ➔ Do you want to control all the configuration "knobs"?
                * **YES** ➔ **[AWS Fargate]** (Full control, managed compute)
                * **NO** ➔ **[AWS App Runner]** (Simplest for web apps & APIs)
    * **Option B: Provisioned (You manage the servers)**
        * Do you want a simplified, easy-to-use UI for prototypes?
            * **YES** ➔ **[AWS Lightsail]** (Fixed price, simple UI setup, no cdk support)
            * **NO** ➔ Do you need container orchestration?
                * **YES** ➔ **[Amazon ECS on EC2]** (Full control over clusters)
                * **NO** ➔ **[Amazon EC2]** (Manual deployment/Virtual Machines)

## Pattern Comparison

| Pattern | Compute | Networking | Scale-to-zero | Idle cost | Ops burden | CDK complexity |
|---|---|---|---|---|---|---|
| `app-runner` | App Runner | Built-in HTTPS | Pause only | ~$5/mo | Lowest | Low |
| `ecs-fargate-alb` | ECS Fargate | ALB | No | ~$20/mo | Low | Medium |
| `ecs-fargate-apigw` | ECS Fargate | API GW + VPC Link | Yes* | ~$10/mo* | Medium | High |
| `ecs-ec2-alb` | ECS on EC2 (Spot) | ALB | No | ~$20/mo | Medium | High |
| `lambda-container` | Lambda | Function URL | Yes | ~$0 | Low | Medium |
| `one-ec2` | Single EC2 + Docker | Public IP | No | ~$4/mo | High | Low |
| `ec2s-behind-alb` | ASG of EC2s + Docker | ALB | No | ~$20/mo | High | Medium |
| `eks-fargate` | EKS + Fargate pods | K8s Ingress/ALB | No | ~$80/mo† | High | High |

\* `ecs-fargate-apigw`: the ~$10/mo is 1 Fargate task (256 CPU/512 MB). API GW + VPC Link have no idle cost, so scaling to 0 tasks would yield ~$0 — but Fargate cold start is 30–90s and the service returns 503 while at 0 tasks.

† `eks-fargate` idle cost: $73/mo EKS control plane ($0.10/hr) + CoreDNS pods on Fargate (~$7/mo). ECS and EKS patterns running tasks in private subnets also require a NAT Gateway (~$32/mo) or VPC endpoints (~$7/mo each) to pull ECR images — not included in the table above.

## Shared Container

All patterns run the same Docker image: a simple Express API with two endpoints:

- `GET /health` — unauthenticated health check (required by ALB/App Runner target group checks)
- `GET /quote` — returns a famous quote, principle, or law from computer science (API-key protected)

The image is built once and stored in ECR via the `elastic-container-registry` pattern. All other patterns reference the image URI from that stack's outputs.

## Authentication

All 8 compute patterns use the same approach: **application-level API key middleware**.

**How it works:**

1. The `elastic-container-registry` stack creates an [SSM SecureString](https://docs.aws.amazon.com/systems-manager/latest/userguide/systems-manager-parameter-store.html) parameter holding a generated API key
2. Each compute pattern reads the key from SSM and injects it as the `API_KEY` environment variable into the container
3. Express middleware checks the `x-api-key` request header against `process.env.API_KEY`
4. `/health` is excluded from auth so ALB/App Runner health checks pass without credentials

**How the API key reaches the container per pattern:**

| Pattern | Injection mechanism |
|---|---|
| `app-runner` | `ImageConfiguration.runtimeEnvironmentSecrets` referencing SSM parameter |
| `ecs-fargate-alb` | Task definition `secrets` from SSM parameter |
| `ecs-fargate-apigw` | Task definition `secrets` from SSM parameter |
| `ecs-ec2-alb` | Task definition `secrets` from SSM parameter |
| `lambda-container` | Lambda environment variable from SSM parameter |
| `one-ec2` | EC2 user data script reads SSM parameter, sets env var |
| `ec2s-behind-alb` | Launch template user data reads SSM parameter, sets env var |
| `eks-fargate` | Kubernetes Secret sourced from SSM, mounted as env var |

## Deploy Order

Deploy `elastic-container-registry` first — it produces the image URI and SSM API key that all other patterns depend on. After that, any pattern can be deployed independently.

```bash
npx cdk deploy ElasticContainerRegistryStack
# then any of:
npx cdk deploy AppRunnerStack
npx cdk deploy EcsFargateAlbStack
# etc.
```

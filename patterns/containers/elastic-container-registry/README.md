# elastic-container-registry

Creates an ECR repository and pushlish an Docker image there.
The Docker image exposes API protected by API_KEY (stored as SSM SecureString parameter).

## Pattern Description

- [ECR Repository](https://docs.aws.amazon.com/AmazonECR/latest/userguide/Repositories.html) — stores the Docker image; lifecycle rule expires untagged images after 1 day to avoid accumulating push-per-build storage costs
- [SSM SecureString](https://docs.aws.amazon.com/systems-manager/latest/userguide/systems-manager-parameter-store.html) — holds the API key; created manually via CLI (CloudFormation cannot create SecureString parameters); KMS-encrypted at rest
- Express container — `GET /health` (unauthenticated, required for ALB/App Runner health checks), `GET /quote` (API-key protected)

## Cost

Region: eu-central-1 — a single small image, low request volume

| Resource | Idle | ~1 image push/day | Cost driver |
|---|---|---|---|
| ECR storage | ~$0.01/mo | ~$0.01/mo | $0.10/GB/mo; tiny image |
| ECR data transfer | $0 | ~$0 | Free within same region |
| SSM SecureString | $0.05/mo | $0.05/mo | Standard param, KMS API calls negligible |

Dominant cost: negligible — ECR and SSM are near-free at this scale.

## Notes

- The SSM parameter must be created manually before deploying any compute pattern — CDK/CloudFormation cannot create SecureString parameters
- `emptyOnDelete: true` on the ECR repo means `cdk destroy` will delete all images; production repos should omit this
- The lifecycle rule only applies to **untagged** images — tagged images (`:latest`, version tags) are kept indefinitely; add a `maxImageCount` rule in production if you push frequently

**ECR registry vs repository vs image**

There is one ECR **registry** per AWS account per region — it exists automatically, you never create it. Its address is `{account}.dkr.ecr.{region}.amazonaws.com`. What CDK creates with `ecr.Repository` is a **repository** within that registry. A repository holds multiple **images**, distinguished by tag.

```
Registry (one per account/region)
└── Repository: hands-on-containers          ← this stack creates this
    ├── Image: :latest
    ├── Image: :v1.2.0
    └── Image: :v1.1.0 (untagged after 1 day → deleted by lifecycle rule)
```

**Passing secrets to a container**

Three approaches, in order of preference:

**SSM Parameter Store vs Secrets Manager**

| | SSM SecureString | Secrets Manager |
|---|---|---|
| Value type | Single string | String or JSON object |
| Cost | ~$0.05/mo | $0.40/secret/mo + $0.05/10k API calls |
| Automatic rotation | No | Yes (via Lambda) |
| Cross-account access | No | Yes |
| Native container injection | ECS, App Runner, Lambda | ECS, App Runner, Lambda |

Use SSM for simple string secrets (API keys, tokens). Use Secrets Manager when you need a structured object, automatic rotation, or cross-account access. For this pattern SSM is sufficient — `API_KEY` is a single string you manage yourself, so rotation adds no value.

**Passing secrets to a container**

Three approaches, in order of preference:

1. **Runtime injection via SSM / Secrets Manager (this pattern)** — the compute platform (ECS, App Runner) fetches the secret at container startup and injects it as an env var. The app reads `process.env.API_KEY`; no SDK code needed in the app. The secret never passes through CI.
   - Pro: secret is scoped to the running container; CI pipeline never sees the value
   - Pro: zero app code — injection is handled by the platform
   - Con: SSM SecureString is a single string; use Secrets Manager if you need a structured JSON object (`{ apiKey, expiresAt }`)

2. **SDK call at app startup** — the app calls `GetParameter` or `GetSecretValue` itself on cold start.
   - Pro: can re-fetch mid-runtime (useful if secret rotates)
   - Con: adds IAM wiring and a network call to the startup path; app code is now coupled to AWS SDK

3. **CI/CD injection (e.g. GitHub Actions)** — the deploy pipeline fetches the secret and passes it to the container at deploy time.
   - Pro: works without any AWS runtime integration
   - Con: the secret exists in the CI environment during deploy (logs, memory), widening the blast radius; CI needs AWS credentials scoped to read secrets

**Alternative: `DockerImageAsset`**

CDK's [`DockerImageAsset`](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ecr_assets-readme.html) builds and pushes the image automatically on `cdk deploy` — no manual `docker push` step. Images land in the CDK bootstrap repository, tagged by a hash of the build context. The tradeoff: every source change produces a new URI, so all compute patterns referencing that image must be redeployed to pick it up. An explicit repository with `:latest` avoids this — push once, all pullers get the new image on their next launch without a CDK redeploy.

## Commands

**1. Deploy the stack**

```bash
npx cdk deploy ElasticContainerRegistryStack
```

**2. Build and tag the container image**

```bash
# Get repo URI from stack output
REPO_URI=$(aws cloudformation describe-stacks \
  --stack-name ElasticContainerRegistryStack \
  --query "Stacks[0].Outputs[?OutputKey=='RepositoryUri'].OutputValue" \
  --output text | tr -d '\r')

cd patterns/containers/elastic-container-registry/example-container
docker build --platform linux/arm64 -t hands-on-containers .
docker tag hands-on-containers:latest "${REPO_URI}:latest"
```

**3. Authenticate Docker to ECR**

```bash
aws ecr get-login-password --region eu-central-1 \
  | docker login --username AWS --password-stdin $REPO_URI
```

**4. Push the image**

```bash
docker push "${REPO_URI}:latest"
```

**5. Create the API key in SSM**

```bash
aws ssm put-parameter \
  --name /hands-on-aws/containers/api-key \
  --type SecureString \
  --value "$(openssl rand -hex 16)"
# Add --overwrite to rotate an existing key
```

**6. Verify**

```bash
# List images in ECR
aws ecr describe-images --repository-name hands-on-containers

# Confirm SSM parameter exists (value hidden)
aws ssm get-parameter --name /hands-on-aws/containers/api-key --with-decryption
```

**7. Destroy**

```bash
npx cdk destroy ElasticContainerRegistryStack
# Stack deletion empties the repo automatically (emptyOnDelete: true)

# Remove the SSM parameter (not managed by CDK)
aws ssm delete-parameter --name /hands-on-aws/containers/api-key
```

**8. Capture CloudFormation template**

```bash
npx cdk synth ElasticContainerRegistryStack > patterns/containers/elastic-container-registry/cloud_formation.yaml
```

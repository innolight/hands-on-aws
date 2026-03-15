# elastic-container-registry

Foundational pattern for all container compute patterns. Creates an ECR repository and establishes the SSM SecureString parameter that holds the shared API key.

## Pattern Description

```
Developer CLI
    |
    |-- docker build/tag/push ---------> ECR Repository (hands-on-containers)
    |                                         |
    |-- aws ssm put-parameter -------> SSM SecureString (/hands-on-aws/containers/api-key)
                                              |
                                    All compute patterns read
                                    this parameter to inject API_KEY
                                    into the container at runtime
```

**Components:**

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
docker build -t hands-on-containers .
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

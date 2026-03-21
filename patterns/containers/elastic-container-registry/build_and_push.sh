#!/usr/bin/env bash
set -euo pipefail

REPO_URI=$(aws cloudformation describe-stacks \
  --stack-name ElasticContainerRegistryStack \
  --query "Stacks[0].Outputs[?OutputKey=='RepositoryUri'].OutputValue" \
  --output text | tr -d '\r')

echo "Repository URI: ${REPO_URI}"

# Create or reuse the multi-arch builder — buildx stores the builder in ~/.docker/buildx
docker buildx create --name multiarch --use 2>/dev/null || docker buildx use multiarch

echo "Authenticating Docker to ECR..."
aws ecr get-login-password --region eu-central-1 \
  | docker login --username AWS --password-stdin "${REPO_URI}"

cd "$(dirname "$0")/example-container"

echo "Building and pushing server image (multi-arch)..."
# Note: `--push` is required for multi-arch — buildx cannot store multi-arch manifests locally.
docker buildx build --platform linux/amd64,linux/arm64 --provenance=false \
  --target server -t "${REPO_URI}:latest" --push .

echo "Building and pushing lambda image (multi-arch)..."
docker buildx build --platform linux/amd64,linux/arm64 --provenance=false \
  --target lambda -t "${REPO_URI}:lambda" --push .

echo "Verifying multi-arch manifests for ${REPO_URI}:latest..."
docker buildx imagetools inspect "${REPO_URI}:latest"

echo "Verifying multi-arch manifests for ${REPO_URI}:lambda..."
docker buildx imagetools inspect "${REPO_URI}:lambda"

echo "Done."

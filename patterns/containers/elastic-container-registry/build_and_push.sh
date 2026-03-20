#!/usr/bin/env bash
set -euo pipefail

REPO_URI=$(aws cloudformation describe-stacks \
  --stack-name ElasticContainerRegistryStack \
  --query "Stacks[0].Outputs[?OutputKey=='RepositoryUri'].OutputValue" \
  --output text | tr -d '\r')

echo "Repository URI: ${REPO_URI}"

cd "$(dirname "$0")/example-container"

echo "Building server image..."
docker build --platform linux/arm64 --provenance=false --target server \
  -t hands-on-containers:latest -t "${REPO_URI}:latest" .

echo "Building lambda image..."
docker build --platform linux/arm64 --provenance=false --target lambda \
  -t hands-on-containers:lambda -t "${REPO_URI}:lambda" .

echo "Authenticating Docker to ECR..."
aws ecr get-login-password --region eu-central-1 \
  | docker login --username AWS --password-stdin "${REPO_URI}"

echo "Pushing server image..."
docker push "${REPO_URI}:latest"

echo "Pushing lambda image..."
docker push "${REPO_URI}:lambda"

echo "Done."

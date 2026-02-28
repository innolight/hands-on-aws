# S3 Static Website + CloudFront

**Pattern Description**:
- Private S3 bucket with [BlockPublicAccess](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html) — no public access
- [CloudFront Distribution](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-working-with.html) serving content globally over HTTPS
- [Origin Access Control (OAC)](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html) — CloudFront authenticates to S3 via signed requests; bucket stays private
- [BucketDeployment](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_s3_deployment-readme.html) deploys a sample `index.html` on stack creation
  - During `cdk deploy`, CDK zips the source files, uploads the archive to the CDK bootstrap assets bucket, then a Lambda-backed custom resource extracts and copies the files into the website bucket
  - Also invalidates the CloudFront cache (`/*`) so changes are visible immediately
  - For a real project, replace `Source.data()` with `Source.asset('./frontend/dist')` to deploy a build directory

**Cost** (us-east-1, PriceClass_100):

| Resource | Idle | ~10K visitors/month | Cost driver |
|---|---|---|---|
| S3 storage | ~$0.00 | ~$0.00 | $0.023/GB — negligible for static files |
| CloudFront transfer | $0.00 | ~$0.01–0.05 | $0.085/GB out — scales with page size × visits |
| CloudFront requests | $0.00 | ~$0.01 | $0.0100/10K HTTPS requests |
| Lambda (deploy-time) | $0.00 | $0.00 | Runs only during `cdk deploy`; sub-second duration |
| OAC | $0.00 | $0.00 | Free |

**Notes**:
- OAC replaces the legacy OAI (Origin Access Identity). OAC supports all S3 regions and SSE-KMS encryption.
- S3 static website hosting (`websiteIndexDocument`) is intentionally NOT enabled — it's incompatible with OAC, which requires the S3 REST API endpoint. CloudFront `defaultRootObject` replaces it.
- `PriceClass_100` (US, Canada, Europe) minimises cost for development. Use `PriceClass_All` for production.
- CloudFront takes ~3-5 min to deploy globally.

**Commands to play with stack**:
- Deploy: `cdk deploy S3StaticWebsiteCloudfront` 
- Open the `DistributionDomainName` output URL in your browser to see the sample page
- Upload new content: `aws s3 cp index.html s3://<BucketName>/index.html`
- Invalidate cache: `aws cloudfront create-invalidation --distribution-id <DistributionId> --paths "/*"`
- Destroy stack: `cdk destroy S3StaticWebsiteCloudfront`
- Capture the CloudFormation yaml: `npx cdk synth S3StaticWebsiteCloudfront > patterns/s3-static-website-cloudfront/cloud_formation.yaml`

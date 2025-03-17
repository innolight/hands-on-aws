# AWS Patterns

In this project, I try to gain deep and hands-on knowledge of architecting application in AWS by using CDK to implement
popular architectural patterns in AWS.

## Patterns

Discover AWS patterns in folder [patterns](./patterns):


- [x] [`s3-polished-configuration`](./patterns/s3-polished-configuration): S3 with encryption, versioning enabled, lifecycle rule, data archiver with Glacier
- [x] [`s3-events-notification`](./patterns/s3-events-notification): S3 → SNS → SQS → SQS (DLQ) 
- [x] [`s3-cross-region-replication`](./patterns/s3-cross-region-replication): S3 → S3 (another region); Multi-region Access Point for S3
- [ ] `s3-static-website-cloudfront`: S3 hosting a static website, using CloudFront for global delivery
- [ ] `s3-lambda-rekognition-dynamodb`: image processing pipeline and metadata storage
- [ ] `s3-behind-sftp`: SFTP access to S3 using AWS Transfer 
- [ ] `dynamodb-global-database`: Dynamodb Global Database (multi-write architecture)
- [ ] `dynamodb-to-s3`: Dynamodb → S3 with Zero-ETL
- [ ] `dynamodb-kinesis`: Dynamodb → Dynamodb Stream → Kinesis Stream → Kinesis Data Firehose → AWS OpenSearch | S3
- [ ] `dynamodb-lambda`: Dynamodb → Dynamodb Stream → Lambda
- [ ] `dynamodb-behind-api-gateway`: API Gateway → Dynamodb
- [ ] `dynamodb-behind-alb`: Application Load Balancer (API) → Dynamodb
- [ ] `ecs-on-fargate`: deployment of Elastic Container Service (container orchestration platform from Amazon)
- [ ] `eks`: Deployment of container to Kubernetes cluster using EKS (Elastic Kubernetes Service)
- [ ] `event-bridge-lambda-job`: Lightweight job with event bridge triggering lambda function using cron schedule  
- [ ] `msk-lambda`: Kafka cluster setup via Amazon Managed Streaming for Kafka (MSK), Lambda consumer
- [ ] `vpc-networking`: VPC, subnets, NAT Gateway, Internet Gateway
- [ ] `waf-shield-ddos-protection`: AWS WAF + Shield for DDoS protection on CloudFront
- [ ] `sagemaker-pipeline-cdk`: Building an end-to-end ML pipeline with AWS SageMaker and CDK
- [ ] `athena-query-s3`: AWS Athena querying structured/unstructured data from S3
- [ ] `glue-etl-job`: AWS Glue ETL job that processes and transforms data in S3 to different format
- [ ] `rds-backup-and-recovery`: Set up automated backups and point-in-time recovery for RDS
- [ ] `rds-two-readable-standbys`: Multi-AZ deployment of RDS with 2 readable standby instance
- [ ] `rds-aurora-cross-region-replication`: RDS Aurora Cross-Region replication + Write Forwarding
- [ ] `rds-aurora-serverless-v2`: Deploying Aurora Serverless v2 with autoscaling
- [ ] `rds-proxy`: RDS proxy in front of RDS

## Development

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `npx cdk deploy`  deploy this stack to your default AWS account/region
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template

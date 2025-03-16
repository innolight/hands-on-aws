# S3 Cross Region Replication

Pattern Description:
- Destination S3 Bucket in specified region
- Source S3 Bucket in default region
- Source S3 Bucket has replication rule to replicate to destination bucket
- IAM role assumed by s3.amazonaws.com Service Principal to read from Source Bucket and Write to Destination Bucket  

Notes:
- 2 different stacks are needed to deploy to 2 S3 buckets in 2 different regions. AWS CloudFormation (which CDK uses under the hood) requires all resources within a stack to be in the same region.

Commands play with stack:
- `cdk deploy S3CrossRegionReplicationStackStep1`: deploy Destination Bucket in `eu-west-1` region. This step output ARN used in steps 2 
- `cdk deploy S3CrossRegionReplicationStackStep2 --parameters replicationRoleArn=<FROM_STEP1> --parameters destinationBucketArn=<FROM_STEP1>`: deploy Source bucket in default region
- In AWS Console, upload an object in source bucket, and see that it's replicated to destination bucket


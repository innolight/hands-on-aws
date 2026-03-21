# S3 Polished Configuration

```
S3 Bucket
  ├── BlockPublicAccess: BLOCK_ALL
  ├── Versioning: enabled
  ├── Encryption: SSE-S3 (S3-managed keys)
  ├── EnforceSSL: bucket policy
  ├── IntelligentTiering: archive access after 365d
  └── Lifecycle Rules
       ├── Glacier at 3y, Deep Archive at 5y  (prefix: object_prefix_filter/)
       ├── Expire after 2y                    (prefix: logs/)
       └── Expire all on 2030-02-01
```

Description:
- [IntelligentTieringConfigurations](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-s3-bucket-intelligenttieringconfiguration.html) to get automated storage cost saving for unknown or unpredictable access patterns
- [LifecycleConfiguration](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-s3-bucket-lifecycleconfiguration.html) for explicit control over transitioning objects between storage tier or object expiration 
- [PublicAccessBlockConfiguration](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-s3-bucket-publicaccessblockconfiguration.html) to block all kind of public access
- [BucketEncryption](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-s3-bucket-bucketencryption.html) for encryption of data at rest, with various approaches, such as
   - SSE-S3: Server-Side Encryption with key managed by S3
   - SS3-KMS (KMS Managed): Service-Side Encryption with key managed by KMS
   - SS3-KMS (Customer Managed): Service-Side Encryption with key managed by customer in KMS
   - SSE-C (Customer Provided): Service-Side Encryption with key provided by customer for each object request
- [VersioningConfiguration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html) to enable Versioning for object in bucket
- Enforce Secure transport (SSL) to prevent serving S3 bucket over HTTP (possible with Static Website Hosting)


import * as cdk from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';

export class S3PolishedConfigurationStack extends cdk.Stack {

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);


    // Create the S3 Bucket with best practices
    const secureBucket = new s3.Bucket(this, 'PolishedS3Bucket', {
      bucketName: `polished-s3-bucket-${this.account}-${this.region}`,

      // Disable public access
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,

      // Enable versioning for data recovery
      versioned: true,

      // Enforce HTTPS access as security best practice
      // It's possible to access S3 via HTTP, when you enable S3 Static Website Hosting, AWS provides a website endpoint
      // that only supports HTTP (not HTTPS). No HTTPS support is available unless you use CloudFront with an SSL certificate.
      enforceSSL: true,

      // Setting for SSE (Service Side Encryption) method:
      //     undefined -> use encryption key provided by customer in each request (SSE-C)
      //     s3.BucketEncryption.S3_MANAGED -> use encryption key managed by S3 (SSE-S3)
      //     s3.BucketEncryption.KMS_MANAGED -> use encryption key managed by KMS (SSE-KMS Managed)
      //     s3.BucketEncryption.KMS -> use encryption key managed by customer in KMS (SSE-KMS)
      // See more in blog post https://crishantha.medium.com/aws-s3-server-side-encryption-608d01231ce1
      encryption: s3.BucketEncryption.S3_MANAGED,


      // Intelligent Tiering automatically moves objects between storage tiers based on access patterns
      // Suitable for data with unknown or unpredictable access patterns
      // For small monitoring and automation fee, we get automatic cost savings by moving data on a granular object
      // level between access tiers when access patterns change.
      intelligentTieringConfigurations: [
        {
          name: 'IntelligentTiering',

          // Filter by Object Tags (up to 10 tags / object)
          // Tags use cases: lifecycle policies, cost allocation, access control, search
          // Tags can be after object is created.
          tags: [{key: 'key', value: 'value'}],

          // Archive Access tier for data that can be accessed asynchronously
          archiveAccessTierTime: cdk.Duration.days(365),
        },
      ],

      // Lifecycle Rules give you explicit control over transitioning objects to different storage classes (like Glacier,
      // Glacier Deep Archive, Standard-IA, etc.) after a specified period
      lifecycleRules: [
        {
          id: 'MoveToGlacierTiers',
          enabled: true,
          prefix: 'object_prefix_filter/',
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(3 * 365), // 3 years
            },
            {
              storageClass: s3.StorageClass.DEEP_ARCHIVE,
              transitionAfter: cdk.Duration.days(5 * 365), // 5 years
            },
          ],
        },
        {
          id: 'DeleteCertainFiles',
          enabled: true,
          expiration: cdk.Duration.days(2 * 365), // Delete after 2 years
          objectSizeGreaterThan: cdk.Size.kibibytes(1).toBytes(), // Apply rule only if > 1KB
          prefix: 'logs/',
          tagFilters: {
            'tag_key': 'tag_value',
          },
        },
        {
          id: 'DeleteEverythingIn2030',
          enabled: true,
          expirationDate: new Date(2030, 1, 1),
        }
      ],

      //  !! Change the following in production.
      // This deletes the bucket when the stack is deleted (for easy cleanup).
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new cdk.CfnOutput(this, 'BucketName', {value: secureBucket.bucketName});
  }
}
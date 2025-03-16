import * as cdk from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';

export class S3CrossRegionReplicationStackStep1 extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);


    const destinationBucket = new s3.Bucket(this, 'DestinationBucket', {
      bucketName: `${cdk.Aws.ACCOUNT_ID}-cross-region-replication-destination-bucket`,
      // Enable versioning (Required for replication)
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      //  !! Change the following in production.
      // This deletes the bucket when the stack is deleted (for easy cleanup).
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Create IAM Role for Replication
    const replicationRole = new iam.Role(this, 'ReplicationRole', {
      description: "Role used to replicate across accounts for S3 buckets",
      assumedBy: new iam.ServicePrincipal('s3.amazonaws.com'),
    });

    // Allow Role to replicate to this bucket
    // Todo: study alternative approach to attach replication Policy to role instead of resource
    // https://aws.plainenglish.io/s3-cross-region-replication-with-aws-cdk-39d5dd3ecee7
    destinationBucket.addReplicationPolicy(replicationRole.roleArn)

    // 🔹 Outputs
    new cdk.CfnOutput(this, 'DestinationBucketName', {
      value: destinationBucket.bucketName
    });
    new cdk.CfnOutput(this, 'DestinationBucketArn', {
      value: destinationBucket.bucketArn
    });
    new cdk.CfnOutput(this, 'ReplicationRoleArn', {
      value: replicationRole.roleArn
    });
  }
}

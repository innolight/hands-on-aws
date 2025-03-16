import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';

export class S3CrossRegionReplicationStackStep2 extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const replicationRoleArn = new cdk.CfnParameter(this, "replicationRoleArn", {
      type: "String",
      description: "The ARN of the replication role in the source account",
    });
    const destinationBucketArn = new cdk.CfnParameter(this, "destinationBucketArn", {
      type: "String",
      description: "The ARN of the replication role in the source account",
    });

    const sourceBucket = new s3.Bucket(this, 'SourceBucket', {
      bucketName: `${cdk.Aws.ACCOUNT_ID}-cross-region-replication-source-bucket`,
      // Enable versioning (Required for replication)
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      //  !! Change the following in production.
      // This deletes the bucket when the stack is deleted (for easy cleanup).
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Allow Replication Role to Read bucket
    const replicationRole = iam.Role.fromRoleArn(this, 'ReplicationRole', replicationRoleArn.valueAsString);
    sourceBucket.grantRead(replicationRole);

    // App replicationConfiguration
    // no high level construct for replication for S3 yet, use low level contruct for now
    const sourceCfnBucket = sourceBucket.node.defaultChild as s3.CfnBucket;
    sourceCfnBucket.replicationConfiguration = {
      role: replicationRoleArn.valueAsString,
      rules: [
        {
          id: 'SourceToDestination',
          priority: 1,
          status: 'Enabled',
          deleteMarkerReplication: {status: 'Disabled'},
          filter: {},
          destination: {
            bucket: destinationBucketArn.valueAsString
          },
        },
      ],
    };

    // Outputs
    new cdk.CfnOutput(this, 'SourceBucketName', {
      value: sourceBucket.bucketName,
    });
  }
}

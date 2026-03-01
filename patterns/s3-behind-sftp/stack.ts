import * as cdk from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as transfer from 'aws-cdk-lib/aws-transfer';

export const s3BehindSftpStackName = 'S3BehindSftp';

// S3BehindSftpStack: SFTP client → Transfer Family (public endpoint, SERVICE_MANAGED) → S3 bucket
export class S3BehindSftpStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Private bucket for SFTP-uploaded files. Name includes account and region
    // to ensure global uniqueness.
    const bucket = new s3.Bucket(this, 'SftpBucket', {
      bucketName: `s3-sftp-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      // !! Change the following in production.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Explicit log group so cdk destroy removes it. Without this, Transfer Family
    // auto-creates a log group that persists after stack deletion.
    const logGroup = new logs.LogGroup(this, 'AccessLogs', {
      logGroupName: '/aws/transfer/s3-sftp',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Transfer Family requires an IAM role to publish structured access logs to
    // CloudWatch Logs. The role must trust transfer.amazonaws.com.
    const loggingRole = new iam.Role(this, 'LoggingRole', {
      assumedBy: new iam.ServicePrincipal('transfer.amazonaws.com'),
    });
    logGroup.grantWrite(loggingRole);

    // SERVICE_MANAGED stores SSH public keys inside Transfer Family — no Lambda,
    // no Secrets Manager, no custom IdP boilerplate. Sufficient for up to 100 users.
    // Alternative: identityProviderType: 'AWS_LAMBDA' with a Secrets Manager-backed
    // Lambda for password auth, more users, or federated identity.
    //
    // PUBLIC endpoint lets any client connect without a VPC. Transfer Family assigns
    // a DNS name; no Elastic IP or VPC configuration needed.
    // Alternative: endpointType: 'VPC' with VpcEndpointDetails for private traffic
    // and stable Elastic IPs.
    const server = new transfer.CfnServer(this, 'SftpServer', {
      protocols: ['SFTP'],
      endpointType: 'PUBLIC',
      identityProviderType: 'SERVICE_MANAGED',
      loggingRole: loggingRole.roleArn,
    });

    // Shared IAM role assumed by Transfer Family on behalf of each SFTP user when
    // making S3 API calls. Both alice and bob use this role; prefix isolation is
    // enforced via LOGICAL home directory mappings, not IAM conditions.
    //
    // s3:ListBucket must be granted on the bucket ARN, not a prefix. IAM does not
    // support prefix-level ListBucket — a common misconfiguration that silently
    // breaks directory listings (ls returns empty instead of an error).
    const userRole = new iam.Role(this, 'UserRole', {
      assumedBy: new iam.ServicePrincipal('transfer.amazonaws.com'),
    });
    bucket.grantReadWrite(userRole);
    userRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [bucket.bucketArn],
    }));

    const sshPublicKeyAlice = new cdk.CfnParameter(this, 'SshPublicKeyAlice', {
      type: 'String',
      description: 'SSH public key for alice (contents of sftp_alice.pub)',
    });

    const sshPublicKeyBob = new cdk.CfnParameter(this, 'SshPublicKeyBob', {
      type: 'String',
      description: 'SSH public key for bob (contents of sftp_bob.pub)',
    });

    // LOGICAL home directory hides the S3 bucket name and prefix from the SFTP
    // client. The user sees / as their root, not /bucket-name/alice. This is the
    // production-correct approach; it acts as a virtual chroot.
    // Alternative: homeDirectoryType: 'PATH' maps the user directly to an S3 path
    // (e.g. /bucket-name/alice), exposing the bucket name to the client.
    new transfer.CfnUser(this, 'AliceUser', {
      serverId: server.attrServerId,
      userName: 'alice',
      role: userRole.roleArn,
      homeDirectoryType: 'LOGICAL',
      homeDirectoryMappings: [{entry: '/', target: `/${bucket.bucketName}/alice`}],
      sshPublicKeys: [sshPublicKeyAlice.valueAsString],
    });

    new transfer.CfnUser(this, 'BobUser', {
      serverId: server.attrServerId,
      userName: 'bob',
      role: userRole.roleArn,
      homeDirectoryType: 'LOGICAL',
      homeDirectoryMappings: [{entry: '/', target: `/${bucket.bucketName}/bob`}],
      sshPublicKeys: [sshPublicKeyBob.valueAsString],
    });

    new cdk.CfnOutput(this, 'BucketName', {value: bucket.bucketName});
    new cdk.CfnOutput(this, 'SftpEndpoint', {
      value: `${server.attrServerId}.server.transfer.${cdk.Aws.REGION}.amazonaws.com`,
    });
  }
}

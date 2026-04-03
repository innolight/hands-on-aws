import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as opensearch from 'aws-cdk-lib/aws-opensearchservice';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as osis from 'aws-cdk-lib/aws-osis';

export const rdsOpensearchPipelineStackName = 'RdsOpensearchPipeline';

interface RdsOpensearchPipelineStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  rdsInstance: rds.DatabaseInstance;
  rdsSecret: secretsmanager.ISecret;
  rdsSG: ec2.SecurityGroup;
  opensearchDomain: opensearch.Domain;
  opensearchDomainSG: ec2.SecurityGroup;
}

// OSI pipeline that performs CDC from RDS PostgreSQL → OpenSearch.
//
// Flow:
//   1. Pipeline takes an RDS snapshot and exports it to S3 (initial full load via Parquet export).
//   2. OSI bulk-indexes the snapshot data into OpenSearch.
//   3. Pipeline switches to CDC mode, reading the WAL via logical replication and
//      streaming inserts/updates/deletes continuously.
//
// Two IAM roles are required:
//   - exportRole: trusted by export.rds.amazonaws.com — writes snapshot Parquet to S3.
//   - pipelineRole: trusted by osis-pipelines.amazonaws.com — orchestrates everything.
export class RdsOpensearchPipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RdsOpensearchPipelineStackProps) {
    super(scope, id, props);

    // --- S3 Bucket: snapshot staging ---
    // OSI exports the RDS snapshot as Parquet files here before the initial bulk index.
    // The bucket is ephemeral — OSI deletes each export object after indexing it.
    // !! Change the following in production: set removalPolicy to RETAIN if you want
    // to keep snapshot exports for replay or audit purposes.
    const snapshotBucket = new s3.Bucket(this, 'SnapshotBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS, // key assigned below
      enforceSSL: true,
      // !! Change the following in production.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // --- KMS Key: snapshot export encryption ---
    // RDS snapshot export to S3 requires a KMS key. The exportRole and pipelineRole both
    // need grants on this key (encrypt on write, decrypt on read/index).
    // !! Change the following in production: set removalPolicy to RETAIN.
    const exportKey = new kms.Key(this, 'ExportKey', {
      description: 'Encrypts RDS snapshot exports for OSI initial full load',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Assign the KMS key to the bucket (replaces the default S3-managed key).
    const cfnBucket = snapshotBucket.node.defaultChild as s3.CfnBucket;
    cfnBucket.bucketEncryption = {
      serverSideEncryptionConfiguration: [
        {
          serverSideEncryptionByDefault: {
            sseAlgorithm: 'aws:kms',
            kmsMasterKeyId: exportKey.keyArn,
          },
        },
      ],
    };

    // --- Export IAM Role ---
    // Trusted by the RDS export service. OSI calls StartExportTask with this role ARN,
    // and RDS assumes it when writing Parquet files to the snapshot bucket.
    const exportRole = new iam.Role(this, 'ExportRole', {
      assumedBy: new iam.ServicePrincipal('export.rds.amazonaws.com'),
      description: 'Allows RDS snapshot export service to write to the OSI snapshot bucket',
    });

    snapshotBucket.grantReadWrite(exportRole);
    snapshotBucket.grantDelete(exportRole);
    exportKey.grantEncryptDecrypt(exportRole);

    // --- Pipeline IAM Role ---
    // Trusted by OSI. Orchestrates snapshot export, reads from S3, indexes into OpenSearch,
    // reads the WAL via logical replication for ongoing CDC, and reads RDS credentials.
    const pipelineRole = new iam.Role(this, 'PipelineRole', {
      assumedBy: new iam.ServicePrincipal('osis-pipelines.amazonaws.com'),
      description: 'Allows OSI pipeline to read from RDS and write to OpenSearch',
    });

    // S3: read/write/delete snapshot objects (initial load) and checkpoint state.
    snapshotBucket.grantReadWrite(pipelineRole);
    snapshotBucket.grantDelete(pipelineRole);

    // KMS: decrypt snapshot Parquet files written by the export role.
    exportKey.grantDecrypt(pipelineRole);

    // SecretsManager: read RDS username/password. Scoped to the specific secret.
    pipelineRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadRdsSecret',
        actions: ['secretsmanager:GetSecretValue'],
        resources: [props.rdsSecret.secretArn],
      }),
    );

    // RDS: describe instance, create/describe snapshots, start export task.
    // Snapshot ARN uses a wildcard prefix because RDS auto-generates the snapshot name.
    pipelineRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RdsSnapshotExport',
        actions: [
          'rds:DescribeDBInstances',
          'rds:DescribeDBSnapshots',
          'rds:CreateDBSnapshot',
          'rds:AddTagsToResource',
          'rds:StartExportTask',
          'rds:DescribeExportTasks',
        ],
        resources: [
          props.rdsInstance.instanceArn,
          // Snapshot ARN: arn:aws:rds:<region>:<account>:snapshot:<db-id>*
          cdk.Arn.format(
            {
              service: 'rds',
              resource: 'snapshot',
              resourceName: `${props.rdsInstance.instanceIdentifier}*`,
            },
            this,
          ),
        ],
      }),
    );

    // iam:PassRole: OSI calls StartExportTask with the exportRole ARN — must be passable.
    pipelineRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PassExportRole',
        actions: ['iam:PassRole'],
        resources: [exportRole.roleArn],
      }),
    );

    // OpenSearch: write CDC events to the domain.
    // ESHttpPost/ESHttpPut/ESHttpDelete cover bulk index, upsert, and delete operations.
    pipelineRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'OpenSearchWrite',
        actions: ['es:ESHttpPost', 'es:ESHttpPut', 'es:ESHttpDelete', 'es:ESHttpGet'],
        resources: [props.opensearchDomain.domainArn, `${props.opensearchDomain.domainArn}/*`],
      }),
    );

    // EC2: OSI manages its own ENIs for VPC placement (creates, attaches, deletes them).
    // These permissions are required for the pipeline to reach RDS in isolated subnets.
    pipelineRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'OsiVpcNetworking',
        actions: [
          'ec2:AttachNetworkInterface',
          'ec2:CreateNetworkInterface',
          'ec2:CreateNetworkInterfacePermission',
          'ec2:DeleteNetworkInterface',
          'ec2:DeleteNetworkInterfacePermission',
          'ec2:DetachNetworkInterface',
          'ec2:DescribeNetworkInterfaces',
          'ec2:DescribeSubnets',
          'ec2:DescribeSecurityGroups',
          'ec2:DescribeVpcs',
        ],
        resources: ['*'],
      }),
    );

    // EC2: OSI tags the ENIs it creates so you can identify them in the console.
    pipelineRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'OsiTagNetworkInterface',
        actions: ['ec2:CreateTags'],
        resources: [`arn:aws:ec2:*:${this.account}:network-interface/*`],
        conditions: {
          StringEquals: { 'aws:RequestTag/OSISManaged': 'true' },
        },
      }),
    );

    // --- Pipeline Security Group ---
    // OSI creates ENIs in the VPC subnets using this SG. Needs outbound to RDS (5432)
    // and OpenSearch (443). No inbound rules — OSI pulls, it doesn't accept connections.
    const pipelineSG = new ec2.SecurityGroup(this, 'PipelineSG', {
      vpc: props.vpc,
      description: 'OSI pipeline security group',
      allowAllOutbound: false,
    });

    pipelineSG.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(5432), 'PostgreSQL to RDS source');

    pipelineSG.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS to OpenSearch domain');

    // Allow pipeline to reach RDS. L1 keeps this rule in this stack's lifecycle,
    // not the RDS stack's — same pattern as rds-cdc-streaming.
    new ec2.CfnSecurityGroupIngress(this, 'PipelineToRds', {
      groupId: props.rdsSG.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      sourceSecurityGroupId: pipelineSG.securityGroupId,
      description: 'PostgreSQL from OSI pipeline',
    });

    // Allow pipeline to reach OpenSearch.
    new ec2.CfnSecurityGroupIngress(this, 'PipelineToOpenSearch', {
      groupId: props.opensearchDomainSG.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 443,
      toPort: 443,
      sourceSecurityGroupId: pipelineSG.securityGroupId,
      description: 'HTTPS from OSI pipeline',
    });

    // --- OSI Pipeline ---
    //
    // The pipeline YAML uses the native `rds` source plugin (not JDBC polling).
    // `stream: true` enables CDC after the initial snapshot — OSI holds a logical
    // replication slot open on RDS and tails the WAL continuously.
    //
    // The `opensearch_action` metadata field maps CDC operations to bulk actions:
    //   INSERT / UPDATE → index (upsert by document_id)
    //   DELETE          → delete
    //
    // document_version_type: "external" — OSI uses the WAL LSN as an optimistic concurrency
    // token. OpenSearch rejects out-of-order updates (e.g. a delayed UPDATE arriving after
    // a newer UPDATE), preventing stale overwrites during pipeline restarts.
    //
    // Secrets extension with refresh_interval: PT1H — OSI re-reads the secret hourly.
    // After a Secrets Manager rotation, the old password remains valid for ≤1h, giving
    // OSI time to pick up the new credentials without a connection failure window.
    //
    // minUnits/maxUnits: 1–4 OCUs. 1 OCU handles low write rates; OSI auto-scales up
    // for bursts. Each OCU costs ~$0.24/hr — keep minUnits=1 to minimise idle cost.
    // !! Raise minUnits in production if sustained throughput requires it.
    const pipelineYaml = cdk.Fn.sub(
      [
        'version: "2"',
        'rds-opensearch-pipeline:',
        '  source:',
        '    rds:',
        '      db_identifier: "${DbIdentifier}"',
        '      engine: postgresql',
        '      database: "demo"',
        '      tables:',
        '        include:',
        '          - "public.articles"',
        '      s3_bucket: "${SnapshotBucket}"',
        '      s3_region: "${Region}"',
        '      s3_prefix: "rds-snapshots"',
        '      export:',
        '        kms_key_id: "${KmsKeyId}"',
        '        iam_role_arn: "${ExportRoleArn}"',
        '      stream: true',
        '      aws:',
        '        sts_role_arn: "${PipelineRoleArn}"',
        '        region: "${Region}"',
        '      authentication:',
        '        username: "${{aws_secrets:rds_secret:username}}"',
        '        password: "${{aws_secrets:rds_secret:password}}"',
        '  sink:',
        '    - opensearch:',
        '        hosts:',
        '          - "https://${DomainEndpoint}"',
        '        index: "${getMetadata(\\"table_name\\")}"',
        '        index_type: custom',
        '        document_id: "${getMetadata(\\"primary_key\\")}"',
        '        action: "${getMetadata(\\"opensearch_action\\")}"',
        '        document_version: "${getMetadata(\\"document_version\\")}"',
        '        document_version_type: "external"',
        '        aws:',
        '          sts_role_arn: "${PipelineRoleArn}"',
        '          region: "${Region}"',
        '  extension:',
        '    aws:',
        '      secrets:',
        '        rds_secret:',
        '          secret_id: "${SecretArn}"',
        '          region: "${Region}"',
        '          sts_role_arn: "${PipelineRoleArn}"',
        '          refresh_interval: PT1H',
      ].join('\n'),
      {
        DbIdentifier: props.rdsInstance.instanceIdentifier,
        SnapshotBucket: snapshotBucket.bucketName,
        Region: this.region,
        KmsKeyId: exportKey.keyId,
        ExportRoleArn: exportRole.roleArn,
        PipelineRoleArn: pipelineRole.roleArn,
        DomainEndpoint: props.opensearchDomain.domainEndpoint,
        SecretArn: props.rdsSecret.secretArn,
      },
    );

    const pipeline = new osis.CfnPipeline(this, 'Pipeline', {
      pipelineName: 'rds-opensearch-cdc',
      minUnits: 1,
      maxUnits: 4,
      pipelineConfigurationBody: pipelineYaml,
      vpcOptions: {
        subnetIds: props.vpc.isolatedSubnets.map((s) => s.subnetId),
        securityGroupIds: [pipelineSG.securityGroupId],
      },
    });

    new cdk.CfnOutput(this, 'PipelineName', { value: pipeline.pipelineName });
    new cdk.CfnOutput(this, 'PipelineArn', { value: pipeline.attrPipelineArn });
    new cdk.CfnOutput(this, 'SnapshotBucketName', { value: snapshotBucket.bucketName });
    new cdk.CfnOutput(this, 'PipelineRoleArn', { value: pipelineRole.roleArn });
  }
}

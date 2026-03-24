import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as opensearch from 'aws-cdk-lib/aws-opensearchservice';
import * as iam from 'aws-cdk-lib/aws-iam';

export const opensearchProvisionedStackName = 'OpenSearchProvisioned';

interface OpenSearchProvisionedStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
}

// VPC → Domain SG → OpenSearch Domain (2 data nodes, 2 AZ, gp3, t3.small)
export class OpenSearchProvisionedStack extends cdk.Stack {
  public readonly domainSG: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: OpenSearchProvisionedStackProps) {
    super(scope, id, props);

    // Domain SG: no ingress rules — consumers add access via CfnSecurityGroupIngress in their own stack.
    const domainSG = new ec2.SecurityGroup(this, 'DomainSG', {
      vpc: props.vpc,
      description: 'OpenSearch Provisioned domain - inbound rules added by consumer stacks',
      allowAllOutbound: false,
    });
    this.domainSG = domainSG;

    const domain = new opensearch.Domain(this, 'Domain', {
      version: opensearch.EngineVersion.OPENSEARCH_2_19,
      capacity: {
        dataNodes: 2,
        // t3 instances are burstable — suitable for dev/learning workloads.
        // Graduate to m6g (Graviton) for sustained production throughput.
        dataNodeInstanceType: 't3.small.search',

        // No dedicated master nodes: acceptable for ≤10 data nodes.
        // Dedicated masters manage cluster state (shard allocation, index metadata)
        // without competing with query/indexing workloads.
        masterNodes: 0,

        // Multi-AZ with Standby adds a dedicated standby node for faster failover.
        // t3 instances don't support it; requires r5/m5/c5 or newer.
        multiAzWithStandbyEnabled: false,
      },
      ebs: {
        volumeSize: 10,
        // gp3: 3,000 baseline IOPS regardless of volume size.
        // gp2: IOPS scale with size (3 IOPS/GB) — a 10 GB gp2 volume gets only 30 IOPS -> Legacy, avoid.
        volumeType: ec2.EbsDeviceVolumeType.GP3,
      },
      // Zone awareness distributes primary and replica shards across 3 AZs.
      // Requires ≥2 data nodes. If one AZ fails, the other still has a full copy.
      zoneAwareness: {
        enabled: true,
        availabilityZoneCount: 2,
      },
      // Two zone, two data notes, two subnets.
      vpcSubnets: [{ subnets: props.vpc.isolatedSubnets.slice(0, 2) }],
      vpc: props.vpc,
      securityGroups: [domainSG],
      // All three encryption settings are immutable after domain creation.
      enforceHttps: true,
      nodeToNodeEncryption: true,
      encryptionAtRest: { enabled: true },
      logging: {
        slowSearchLogEnabled: true,
        appLogEnabled: true,
      },
      // !! Change the following in production: set removalPolicy to RETAIN.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // !! Change the following in production: replace 'root' with the specific IAM role
    // or user that needs access. Use separate read-only and write principals.
    domain.addAccessPolicies(
      new iam.PolicyStatement({
        actions: ['es:*'],
        effect: iam.Effect.ALLOW,
        principals: [new iam.AccountRootPrincipal()],
        resources: [domain.domainArn, `${domain.domainArn}/*`],
      }),
    );

    new cdk.CfnOutput(this, 'DomainEndpoint', { value: `https://${domain.domainEndpoint}` });
    new cdk.CfnOutput(this, 'DomainName', { value: domain.domainName });
  }
}

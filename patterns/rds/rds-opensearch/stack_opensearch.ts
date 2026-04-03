import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as opensearch from 'aws-cdk-lib/aws-opensearchservice';
import * as iam from 'aws-cdk-lib/aws-iam';

export const rdsOpensearchOpenSearchStackName = 'RdsOpensearchOpenSearch';

interface RdsOpensearchOpenSearchStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
}

// OpenSearch domain that receives CDC events from the OSI pipeline.
// Exposes both `domain` (for endpoint/ARN references in the pipeline stack)
// and `domainSG` (so the pipeline stack can add its ingress rule via CfnSecurityGroupIngress).
export class RdsOpensearchOpenSearchStack extends cdk.Stack {
  public readonly domain: opensearch.Domain;
  public readonly domainSG: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: RdsOpensearchOpenSearchStackProps) {
    super(scope, id, props);

    // No ingress rules here — the pipeline stack adds its own rule via CfnSecurityGroupIngress
    // so the rule lifecycle stays in the consuming stack, not this one.
    this.domainSG = new ec2.SecurityGroup(this, 'DomainSG', {
      vpc: props.vpc,
      description: 'OpenSearch domain security group - inbound rules added by consumer stacks',
      allowAllOutbound: false,
    });

    this.domain = new opensearch.Domain(this, 'Domain', {
      version: opensearch.EngineVersion.OPENSEARCH_2_19,
      capacity: {
        dataNodes: 2,
        // t3 instances are burstable — suitable for dev/learning workloads.
        // Graduate to m6g (Graviton) for sustained production indexing throughput.
        dataNodeInstanceType: 't3.small.search',
        masterNodes: 0,
        multiAzWithStandbyEnabled: false,
      },
      ebs: {
        volumeSize: 10,
        volumeType: ec2.EbsDeviceVolumeType.GP3,
      },
      zoneAwareness: {
        enabled: true,
        availabilityZoneCount: 2,
      },
      vpcSubnets: [{ subnets: props.vpc.isolatedSubnets.slice(0, 2) }],
      vpc: props.vpc,
      securityGroups: [this.domainSG],
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

    // !! Change the following in production: grant only the OSI pipeline role write access
    // and a dedicated read-only role for search queries. Never use AccountRootPrincipal in prod.
    this.domain.addAccessPolicies(
      new iam.PolicyStatement({
        actions: ['es:*'],
        effect: iam.Effect.ALLOW,
        principals: [new iam.AccountRootPrincipal()],
        resources: [this.domain.domainArn, `${this.domain.domainArn}/*`],
      }),
    );

    new cdk.CfnOutput(this, 'DomainEndpoint', { value: `https://${this.domain.domainEndpoint}` });
    new cdk.CfnOutput(this, 'DomainName', { value: this.domain.domainName });
    new cdk.CfnOutput(this, 'DomainArn', { value: this.domain.domainArn });
  }
}

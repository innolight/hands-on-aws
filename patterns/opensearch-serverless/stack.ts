import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as oss from 'aws-cdk-lib/aws-opensearchserverless';

export const opensearchServerlessStackName = 'OpenSearchServerless';

interface OpenSearchServerlessStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
}

// VPC → AOSS VPC endpoint (isolated subnets) → OpenSearch Serverless collection
export class OpenSearchServerlessStack extends cdk.Stack {
  public readonly vpcEndpointSG: ec2.SecurityGroup;
  public readonly collectionName: string;

  constructor(scope: Construct, id: string, props: OpenSearchServerlessStackProps) {
    super(scope, id, props);

    this.collectionName = 'search-demo';
    const collectionName = this.collectionName;

    // VPC endpoint SG: no ingress rules — consumers add access via CfnSecurityGroupIngress in their own stack.
    const vpcEndpointSG = new ec2.SecurityGroup(this, 'VpcEndpointSG', {
      vpc: props.vpc,
      description: 'OpenSearch Serverless VPC endpoint — inbound rules added by consumer stacks',
      allowAllOutbound: false,
    });
    this.vpcEndpointSG = vpcEndpointSG;

    // Encryption policy: AWS-owned key (no extra cost, no key management).
    // Alternative: customer-managed CMK — required if you need key rotation control or
    // cross-account access, but adds ~$1/month per key and an extra KMS call per request.
    const encryptionPolicy = new oss.CfnSecurityPolicy(this, 'EncryptionPolicy', {
      name: `${collectionName}-encryption`,
      type: 'encryption',
      policy: JSON.stringify({
        Rules: [{ ResourceType: 'collection', Resource: [`collection/${collectionName}`] }],
        AWSOwnedKey: true,
      }),
    });

    // VPC endpoint: placed in isolated subnets so it never has a route to the internet.
    // AOSS VPC endpoints use interface endpoints (ENIs) — one per subnet.
    // Note: CfnVpcEndpoint is an AOSS-specific resource, not an EC2 VPC endpoint.
    const vpcEndpoint = new oss.CfnVpcEndpoint(this, 'VpcEndpoint', {
      name: `${collectionName}-vpce`,
      vpcId: props.vpc.vpcId,
      subnetIds: props.vpc.isolatedSubnets.map((s) => s.subnetId),
      securityGroupIds: [vpcEndpointSG.securityGroupId],
    });

    // Network policy: VPC-only access via the VPC endpoint created above.
    // PublicAccessType: DISABLED means no internet-facing endpoint is created.
    // The VPC endpoint ID is referenced via vpcEndpoint.ref (the logical ID resolves
    // to the physical endpoint ID after creation).
    const networkPolicy = new oss.CfnSecurityPolicy(this, 'NetworkPolicy', {
      name: `${collectionName}-network`,
      type: 'network',
      policy: JSON.stringify([
        {
          Rules: [
            { ResourceType: 'collection', Resource: [`collection/${collectionName}`] },
            { ResourceType: 'dashboard', Resource: [`collection/${collectionName}`] },
          ],
          AllowFromPublic: false,
          SourceVPCEs: [vpcEndpoint.ref],
        },
      ]),
    });

    // Data access policy: grants the deploying account's root full permissions.
    // !! Change the following in production: replace 'root' with the specific IAM role
    // or user that needs access. Least-privilege means separate read-only and write
    // principals, scoped to specific index names instead of '*'.
    const dataAccessPolicy = new oss.CfnAccessPolicy(this, 'DataAccessPolicy', {
      name: `${collectionName}-data-access`,
      type: 'data',
      policy: JSON.stringify([
        {
          Rules: [
            {
              ResourceType: 'collection',
              Resource: [`collection/${collectionName}`],
              Permission: [
                'aoss:CreateCollectionItems',
                'aoss:DeleteCollectionItems',
                'aoss:UpdateCollectionItems',
                'aoss:DescribeCollectionItems',
              ],
            },
            {
              ResourceType: 'index',
              Resource: [`index/${collectionName}/*`],
              Permission: [
                'aoss:CreateIndex',
                'aoss:DeleteIndex',
                'aoss:UpdateIndex',
                'aoss:DescribeIndex',
                'aoss:ReadDocument',
                'aoss:WriteDocument',
              ],
            },
          ],
          Principal: [`arn:aws:iam::${this.account}:root`],
        },
      ]),
    });

    // Collection: SEARCH type is optimized for low-latency queries (vs TIMESERIES or VECTORSEARCH).
    // standbyReplicas DISABLED = 2 OCUs minimum (~$0.48/hr); ENABLED = 4 OCUs minimum (~$0.96/hr).
    // !! Change the following in production: set standbyReplicas: 'ENABLED' for HA across AZs.
    // Note: standbyReplicas is immutable after creation — you must recreate the collection to change it.
    const collection = new oss.CfnCollection(this, 'Collection', {
      name: collectionName,
      type: 'SEARCH',
      standbyReplicas: 'DISABLED',
    });
    // Collection creation requires both policies to already exist.
    collection.addDependency(encryptionPolicy);
    collection.addDependency(networkPolicy);
    collection.addDependency(dataAccessPolicy);

    new cdk.CfnOutput(this, 'CollectionEndpoint', { value: collection.attrCollectionEndpoint });
    new cdk.CfnOutput(this, 'CollectionName', { value: collectionName });
    new cdk.CfnOutput(this, 'DashboardEndpoint', { value: collection.attrDashboardEndpoint });
    new cdk.CfnOutput(this, 'VpcEndpointId', { value: vpcEndpoint.ref });
  }
}

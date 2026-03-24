import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

export const vpcSubnetsStackName = 'VpcSubnets';

interface VpcSubnetsStackProps extends cdk.StackProps {
  // 'aws-managed' → AWS NAT Gateway (~$35/mo/each, no ops).
  // 'self-managed' → NAT Instance on t4g.nano (~$3.40/mo, ~90% cheaper, requires instance management).
  natProviderType?: 'aws-managed' | 'self-managed';
}

// 3-tier VPC: Public (IGW) → Private (NAT egress, optional) → Isolated (no internet)
export class VpcSubnetsStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props?: VpcSubnetsStackProps) {
    super(scope, id, props);

    // natGateways=0 → no outbound internet from private subnets; use VPC Endpoints for AWS services instead.
    // natGateways=1 → single NAT GW (cheapest HA trade-off, cross-AZ traffic charged for AZ2/AZ3).
    // natGateways=3 → one per AZ, eliminates cross-AZ NAT traffic cost in production.
    const natGateways = Number(this.node.tryGetContext('natGateways') ?? '0');

    const natProviderType = props?.natProviderType ?? 'self-managed';

    // NAT Instance (self-managed): t4g.nano runs Amazon Linux 2023; CDK injects user data that
    // installs iptables and configures MASQUERADE NAT, routing traffic out to the IGW.
    // ~$3.40/mo vs ~$35/mo for a NAT Gateway — saves ~90% for dev/learning stacks.
    // Trade-offs: single point of failure per instance, lower max bandwidth (~5 Gbps on t4g.nano),
    // manual patching required. Not recommended for production without HA configuration.
    const selfManagedNATGatewayProvider =
      natGateways > 0 && natProviderType === 'self-managed'
        ? ec2.NatProvider.instanceV2({
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
            // OUTBOUND_ONLY blocks unsolicited inbound by default — matches NAT Gateway behaviour.
            defaultAllowedTraffic: ec2.NatTrafficDirection.OUTBOUND_ONLY,
          })
        : undefined;

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 3,
      natGateways,
      natGatewayProvider: selfManagedNATGatewayProvider,
      subnetConfiguration: [
        // Public subnets: attached to the Internet Gateway. Use for load balancers,
        // NAT Gateways, and bastion hosts — not application workloads.
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 20 },

        // Private subnets: outbound internet via NAT Gateway. Use for app servers,
        // Lambda, ECS tasks that need to call external APIs.
        // When natGateways=0, these subnets have no internet route (effectively isolated).
        { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 20 },

        // Isolated subnets: no route to internet in either direction. Use for databases,
        // caches, and internal services — the most restrictive tier.
        { name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 20 },
      ],
    });

    // OUTBOUND_ONLY adds egress but no ingress to the NAT SG. Without this rule, traffic from
    // private subnets reaches the NAT instance ENI but gets dropped by the security group.
    // AWS NAT Gateways have no SGs so this gap only affects self-managed NAT instances.
    if (selfManagedNATGatewayProvider) {
      selfManagedNATGatewayProvider.securityGroup.addIngressRule(
        // use the full VPC CIDR instead of individual private subnet CIDRs for simplicity
        // only private subnets have routes pointing to the NAT instance anyway, so public/isolated subnet traffic never arrives here.
        ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
        // allows all protocols and ports (maps to IpProtocol: "-1")
        ec2.Port.allTraffic(),
        'Allow traffic from private subnets for NAT forwarding',
      );
    }

    new cdk.CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
    new cdk.CfnOutput(this, 'VpcCidr', { value: this.vpc.vpcCidrBlock });
    new cdk.CfnOutput(this, 'AvailabilityZones', { value: this.vpc.availabilityZones.join(', ') });
    new cdk.CfnOutput(this, 'NatGatewayCount', { value: String(natGateways) });
    new cdk.CfnOutput(this, 'PublicSubnetIds', { value: this.vpc.publicSubnets.map((s) => s.subnetId).join(', ') });
    // privateSubnets = PRIVATE_WITH_EGRESS tier
    new cdk.CfnOutput(this, 'PrivateSubnetIds', { value: this.vpc.privateSubnets.map((s) => s.subnetId).join(', ') });
    new cdk.CfnOutput(this, 'IsolatedSubnetIds', { value: this.vpc.isolatedSubnets.map((s) => s.subnetId).join(', ') });
  }
}

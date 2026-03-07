import * as cdk from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

export const vpcSubnetsStackName = 'VpcSubnets';

// 3-tier VPC: Public (IGW) → Private (NAT egress, optional) → Isolated (no internet)
export class VpcSubnetsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // natGateways=0 → no outbound internet from private subnets; use VPC Endpoints for AWS services instead.
    // natGateways=1 → single NAT GW (cheapest HA trade-off, cross-AZ traffic charged for AZ2/AZ3).
    // natGateways=3 → one per AZ, eliminates cross-AZ NAT traffic cost in production.
    const natGateways = Number(this.node.tryGetContext('natGateways') ?? '0');

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 3,
      natGateways,
      subnetConfiguration: [
        // Public subnets: attached to the Internet Gateway. Use for load balancers,
        // NAT Gateways, and bastion hosts — not application workloads.
        {name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 20},

        // Private subnets: outbound internet via NAT Gateway. Use for app servers,
        // Lambda, ECS tasks that need to call external APIs.
        // When natGateways=0, these subnets have no internet route (effectively isolated).
        {name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 20},

        // Isolated subnets: no route to internet in either direction. Use for databases,
        // caches, and internal services — the most restrictive tier.
        {name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 20},
      ],
    });

    new cdk.CfnOutput(this, 'VpcId', {value: vpc.vpcId});
    new cdk.CfnOutput(this, 'VpcCidr', {value: vpc.vpcCidrBlock});
    new cdk.CfnOutput(this, 'AvailabilityZones', {value: vpc.availabilityZones.join(', ')});
    new cdk.CfnOutput(this, 'NatGatewayCount', {value: String(natGateways)});
    new cdk.CfnOutput(this, 'PublicSubnetIds', {value: vpc.publicSubnets.map(s => s.subnetId).join(', ')});
    // privateSubnets = PRIVATE_WITH_EGRESS tier
    new cdk.CfnOutput(this, 'PrivateSubnetIds', {value: vpc.privateSubnets.map(s => s.subnetId).join(', ')});
    new cdk.CfnOutput(this, 'IsolatedSubnetIds', {value: vpc.isolatedSubnets.map(s => s.subnetId).join(', ')});
  }
}

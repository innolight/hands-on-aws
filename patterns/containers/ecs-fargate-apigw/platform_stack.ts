import * as cdk from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';

export const ecsPlatformStackName = 'EcsPlatformStack';

interface EcsPlatformStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
}

// Shared ECS platform — cluster, Cloud Map namespace, VPC Link — deployed once, consumed by per-service stacks
export class EcsPlatformStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly namespace: servicediscovery.PrivateDnsNamespace;
  public readonly vpcLink: apigwv2.VpcLink;
  public readonly vpcLinkSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: EcsPlatformStackProps) {
    super(scope, id, props);

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
    });

    // Private DNS namespace for Cloud Map — all services in this cluster register here
    this.namespace = new servicediscovery.PrivateDnsNamespace(this, 'Namespace', {
      name: 'ecs-fargate-apigw.local',
      vpc: props.vpc,
    });

    // VPC Link SG: API Gateway originates requests through the VPC Link ENIs — no explicit inbound rules needed
    this.vpcLinkSg = new ec2.SecurityGroup(this, 'VpcLinkSG', {
      vpc: props.vpc,
      description: 'Security group for API Gateway VPC Link',
    });

    this.vpcLink = new apigwv2.VpcLink(this, 'VpcLink', {
      vpc: props.vpc,
      subnets: {subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS},
      securityGroups: [this.vpcLinkSg],
    });
  }
}

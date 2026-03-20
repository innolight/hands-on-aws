import * as cdk from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';

export const ecsFargateAlbNetworkingStackName = 'EcsFargateAlbNetworkingStack';

interface EcsFargateAlbNetworkingStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
}

// Internet → ALB → listener rules → per-service target groups → Fargate tasks
export class EcsFargateAlbNetworkingStack extends cdk.Stack {
  public readonly listener: elbv2.ApplicationListener;

  constructor(scope: Construct, id: string, props: EcsFargateAlbNetworkingStackProps) {
    super(scope, id, props);

    const albSg = new ec2.SecurityGroup(this, 'AlbSG', {
      vpc: props.vpc,
      description: 'Security group for ALB - inbound HTTP from internet',
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP from anywhere');
    albSg.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(80), 'Allow HTTP from anywhere (IPv6)');

    const alb = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
      vpc: props.vpc,
      internetFacing: true,
      vpcSubnets: {subnetType: ec2.SubnetType.PUBLIC},
      securityGroup: albSg,
      // Strip malformed HTTP headers — prevents header-smuggling attacks on downstream services.
      // !! Change: ALB default is false; set true in production.
      dropInvalidHeaderFields: true,
    });

    // Default action returns 404 — unmatched paths are rejected, not forwarded to a random service.
    // Each service adds its own ListenerRule with a path condition (e.g. /quote-service/*).
    this.listener = alb.addListener('HttpListener', {
      port: 80,
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'Not Found',
      }),
    });

    new cdk.CfnOutput(this, 'AlbEndpoint', {value: `http://${alb.loadBalancerDnsName}`});
  }
}

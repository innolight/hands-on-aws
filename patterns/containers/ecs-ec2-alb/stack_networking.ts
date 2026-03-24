import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';

export const ecsEc2AlbNetworkingStackName = 'EcsEc2AlbNetworkingStack';

interface EcsEc2AlbNetworkingStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
}

// Internet → ALB → listener rules → per-service target groups → ECS EC2 tasks
export class EcsEc2AlbNetworkingStack extends cdk.Stack {
  public readonly listener: elbv2.ApplicationListener;
  public readonly albSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: EcsEc2AlbNetworkingStackProps) {
    super(scope, id, props);

    this.albSg = new ec2.SecurityGroup(this, 'AlbSG', {
      vpc: props.vpc,
      description: 'Security group for ALB - inbound HTTP from internet',
    });
    this.albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP from anywhere');
    this.albSg.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(80), 'Allow HTTP from anywhere (IPv6)');

    const alb = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
      vpc: props.vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: this.albSg,
      // Strip malformed HTTP headers — prevents header-smuggling attacks on downstream services.
      // !! Change: ALB default is false; set true in production.
      dropInvalidHeaderFields: true,
    });

    // Default action returns 404 — unmatched paths are rejected, not forwarded to a random service.
    // Each service adds its own ListenerRule with a path condition (e.g. /ecs-ec2-alb/*).
    this.listener = alb.addListener('HttpListener', {
      port: 80,
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'Not Found',
      }),
    });

    new cdk.CfnOutput(this, 'AlbEndpoint', { value: `http://${alb.loadBalancerDnsName}` });
  }
}

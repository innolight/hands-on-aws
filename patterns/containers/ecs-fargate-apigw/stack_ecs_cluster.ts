import * as cdk from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';

export const ecsClusterStackName = 'EcsClusterStack';

interface EcsClusterStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
}

// Shared ECS cluster and Cloud Map namespace — deployed once, consumed by per-service compute stacks
export class EcsClusterStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly namespace: servicediscovery.PrivateDnsNamespace;

  constructor(scope: Construct, id: string, props: EcsClusterStackProps) {
    super(scope, id, props);

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
    });

    // Private DNS namespace for Cloud Map — all services in this cluster register here
    this.namespace = new servicediscovery.PrivateDnsNamespace(this, 'Namespace', {
      name: 'ecs-fargate-apigw.local',
      vpc: props.vpc,
    });
  }
}

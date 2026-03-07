import * as cdk from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';

export const ssmBastionStackName = 'SsmBastion';

interface SsmBastionStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
}

// EC2 bastion reachable exclusively via SSM port forwarding — no SSH, no inbound rules.
export class SsmBastionStack extends cdk.Stack {
  public readonly bastion: ec2.Instance;
  public readonly bastionSG: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: SsmBastionStackProps) {
    super(scope, id, props);

    // No inbound rules — all access is via SSM port forwarding.
    this.bastionSG = new ec2.SecurityGroup(this, 'BastionSG', {
      vpc: props.vpc,
      description: 'Bastion security group - no inbound',
      allowAllOutbound: true,
    });

    // AmazonSSMManagedInstanceCore allows SSM agent to register and accept sessions.
    // Bastion is in a public subnet so it reaches SSM endpoints over the internet directly.
    const bastionRole = new iam.Role(this, 'BastionRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // ARM + t4g.nano (~$3/mo) is the cheapest option; Amazon Linux 2023 ARM AMI used.
    this.bastion = new ec2.Instance(this, 'Bastion', {
      vpc: props.vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      vpcSubnets: {subnetType: ec2.SubnetType.PUBLIC},
      securityGroup: this.bastionSG,
      role: bastionRole,
      // No SSH key — access is exclusively via SSM.
    });

    new cdk.CfnOutput(this, 'BastionInstanceId', {value: this.bastion.instanceId});
  }
}

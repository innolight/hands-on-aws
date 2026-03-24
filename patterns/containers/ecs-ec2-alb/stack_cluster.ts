import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';

export const ecsEc2ClusterStackName = 'EcsEc2ClusterStack';

interface EcsEc2ClusterStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
}

// Dedicated ECS cluster with EC2 Spot capacity provider — ASG managed by ECS managed scaling
export class EcsEc2ClusterStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly instanceSg: ec2.SecurityGroup;
  public readonly capacityProviderName: string;

  constructor(scope: Construct, id: string, props: EcsEc2ClusterStackProps) {
    super(scope, id, props);

    // --- ECS Cluster ---
    // Dedicated cluster for ECS-on-EC2. The shared EcsClusterStack is Fargate-only;
    // adding an EC2 capacity provider there would change its blast radius and force
    // a redeploy of shared infrastructure whenever this pattern's ASG config changes.
    this.cluster = new ecs.Cluster(this, 'Cluster', { vpc: props.vpc });

    // --- Instance SG ---
    // No explicit inbound rules — the compute stack's attachToApplicationTargetGroup() call
    // triggers CDK Connections to auto-add an ingress rule (ALB SG → this SG on the
    // ephemeral port range 32768-65535) for bridge-mode dynamic port mapping.
    this.instanceSg = new ec2.SecurityGroup(this, 'InstanceSG', {
      vpc: props.vpc,
      description: 'Security group for ECS EC2 instances',
    });

    // --- Instance Role ---
    // ECS on EC2 has 3 IAM roles (vs 1 in raw-Docker ec2s-behind-alb):
    //   1. Instance role (this) — for the ECS agent running on the host
    //   2. Execution role — for ECS to pull images and inject secrets (CDK auto-creates)
    //   3. Task role — for the running container to call AWS APIs (none needed here)
    const instanceRole = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        // ECS agent: register instance, pull images, manage tasks, submit CloudWatch metrics
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2ContainerServiceforEC2Role'),
        // SSM Session Manager: SSH-less debugging via `aws ssm start-session --target <instance-id>`
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // --- Launch Template ---
    // ECS-optimized AMI has the ECS agent, Docker, and iptables pre-installed.
    // Alternative: generic AL2023 + manual Docker/agent install (like ec2s-behind-alb) —
    // more fragile (agent version drift, startup ordering) and slower to boot.
    // userData must be explicitly created and passed so CDK can append the ECS cluster name
    // (ECS_CLUSTER=...) to /etc/ecs/ecs.config — the agent reads this on startup to self-register.
    const userData = ec2.UserData.forLinux();
    const launchTemplate = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
      machineImage: ecs.EcsOptimizedImage.amazonLinux2023(ecs.AmiHardwareType.ARM),
      instanceType: new ec2.InstanceType('t4g.micro'),
      securityGroup: this.instanceSg,
      role: instanceRole,
      // IMDSv2 required — prevents SSRF-based metadata credential theft
      httpTokens: ec2.LaunchTemplateHttpTokens.REQUIRED,
      userData,
    });

    // --- ASG ---
    // mixedInstancesPolicy is the only way to use Spot with fleet-level controls (allocation strategy,
    // On-Demand/Spot ratio, multi-type diversity). Without it, a bare launchTemplate gives 100% On-Demand
    // with a single instance type; the legacy spotPrice field on the launch template is deprecated.
    const asg = new autoscaling.AutoScalingGroup(this, 'ASG', {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      mixedInstancesPolicy: {
        launchTemplate,
        instancesDistribution: {
          // 100% Spot — no on-demand fallback. ~60-70% cost saving vs On-Demand.
          // !! Change in production: set onDemandBaseCapacity to at least 1 for a stable baseline,
          // or use onDemandPercentageAboveBaseCapacity: 25 for a 75/25 Spot/On-Demand mix.
          onDemandBaseCapacity: 0,
          onDemandPercentageAboveBaseCapacity: 0,
          // AWS-recommended: picks Spot pools with lowest interruption risk AND lowest price.
          // Alternative: LOWEST_PRICE — cheaper but higher interruption rate.
          spotAllocationStrategy: autoscaling.SpotAllocationStrategy.PRICE_CAPACITY_OPTIMIZED,
        },
        // Multiple ARM64 types give PRICE_CAPACITY_OPTIMIZED more Spot pools to evaluate per AZ.
        // With a single type, the algorithm has only one pool per AZ — no diversity to optimize over.
        // All types must be ARM64 to match the launch template's ECS-optimized AMI (Amazon Linux 2023 ARM).
        launchTemplateOverrides: [
          { instanceType: new ec2.InstanceType('t4g.micro') }, // 2 vCPU, 1 GiB — ~$0.0042/hr Spot
          { instanceType: new ec2.InstanceType('t4g.small') }, // 2 vCPU, 2 GiB
          { instanceType: new ec2.InstanceType('c7g.medium') }, // 1 vCPU, 2 GiB — compute-optimized
        ],
      },
      // !! Change in production: set minCapacity >= 2 for multi-AZ Spot instance diversity
      minCapacity: 1,
      maxCapacity: 4,
      // Proactively replaces Spot instances that receive a rebalance recommendation
      // before the 2-minute interruption notice — reduces downtime from Spot reclaims.
      // ECS managed termination protection (on the capacity provider) ensures the instance
      // is set to DRAINING first, so tasks are gracefully stopped before replacement.
      capacityRebalance: true,
      // ELB health check: ASG marks instances unhealthy if the ALB target group reports them as unhealthy.
      // Default EC2 health check only catches stopped/terminated instances, not broken Docker or app.
      // Grace period: ECS-optimized AMI boots + ECS agent registers + image pull ≈ 90-120s.
      healthChecks: autoscaling.HealthChecks.withAdditionalChecks({
        additionalTypes: [autoscaling.AdditionalHealthCheckType.ELB],
        gracePeriod: cdk.Duration.seconds(120),
      }),
      // Rolling update: replaces instances in batches, keeping min healthy capacity during deploys.
      // Alternative: replacing update (terminate all, launch new) — faster but causes downtime.
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate(),
    });

    // --- Capacity Provider ---
    // Managed scaling: ECS adjusts the ASG's desired count to match task demand.
    // targetCapacity=100 means ECS aims for 100% utilization of registered instances —
    // i.e., no headroom. Lower values (e.g. 80) keep spare capacity for faster task placement.
    // Managed termination protection: prevents ASG from terminating instances that still have
    // running tasks during scale-in. ECS drains the instance (stops tasks gracefully) first.
    // capacityProviderName must not start with "aws", "ecs", or "fargate" (ECS API rejects them,
    // case-insensitively). Without an explicit name, CloudFormation derives one from the stack
    // name ("EcsEc2ClusterStack-..."), which triggers the "ecs" prefix rejection.
    const capacityProvider = new ecs.AsgCapacityProvider(this, 'AsgCapacityProvider', {
      autoScalingGroup: asg,
      capacityProviderName: 'SpotCapacityProvider',
      enableManagedScaling: true,
      targetCapacityPercent: 100,
      enableManagedTerminationProtection: true,
    });
    this.cluster.addAsgCapacityProvider(capacityProvider);
    this.capacityProviderName = capacityProvider.capacityProviderName;
  }
}

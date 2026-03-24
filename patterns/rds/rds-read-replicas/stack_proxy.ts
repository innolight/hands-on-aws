import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';

export const rdsReadReplicasProxyStackName = 'RdsReadReplicasProxy';

interface RdsReadReplicasProxyStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  bastionSG: ec2.SecurityGroup;
  primary: rds.DatabaseInstance;
  dbSG: ec2.SecurityGroup;
}

// RDS Proxy in front of the primary + replicas.
// Bastion → Proxy → Primary (R/W) or Replica(s) (R/O, via read-only endpoint).
//
// Uses L1 constructs (CfnDBProxy) to avoid the L2's auto-wiring, which would inject
// a CfnSecurityGroupIngress into the RDS stack (creating a circular cross-stack dependency).
// Instead, the proxy→DB ingress is owned explicitly by this stack.
export class RdsReadReplicasProxyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RdsReadReplicasProxyStackProps) {
    super(scope, id, props);

    const proxySG = new ec2.SecurityGroup(this, 'ProxySG', {
      vpc: props.vpc,
      description: 'RDS Proxy security group',
      allowAllOutbound: false,
    });

    new ec2.CfnSecurityGroupIngress(this, 'BastionToProxy', {
      groupId: proxySG.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      sourceSecurityGroupId: props.bastionSG.securityGroupId,
      description: 'PostgreSQL from bastion to proxy',
    });

    // L1 ingress keeps this rule owned by the proxy stack, not the RDS stack.
    new ec2.CfnSecurityGroupIngress(this, 'ProxyToDb', {
      groupId: props.dbSG.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      sourceSecurityGroupId: proxySG.securityGroupId,
      description: 'PostgreSQL from proxy to DB',
    });

    // RDS Proxy authenticates to the DB using the primary's Secrets Manager secret.
    const proxyRole = new iam.Role(this, 'ProxyRole', {
      assumedBy: new iam.ServicePrincipal('rds.amazonaws.com'),
    });
    props.primary.secret!.grantRead(proxyRole);

    const subnetIds = props.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds;

    // CfnDBProxy auto-discovers replicas through the primary — no per-replica config needed.
    const cfnProxy = new rds.CfnDBProxy(this, 'Proxy', {
      dbProxyName: cdk.Fn.sub('${AWS::StackName}-proxy'),
      engineFamily: 'POSTGRESQL',
      roleArn: proxyRole.roleArn,
      auth: [
        {
          authScheme: 'SECRETS',
          secretArn: props.primary.secret!.secretArn,
          iamAuth: 'DISABLED',
          clientPasswordAuthType: rds.ClientPasswordAuthType.POSTGRES_SCRAM_SHA_256,
        },
      ],
      vpcSubnetIds: subnetIds,
      vpcSecurityGroupIds: [proxySG.securityGroupId],
      // Enforce encryption for data in transit to proxy
      requireTls: true,

      // Connections idle for x minutes are returned to the pool and eventually closed.
      // Must be higher than your application's typical idle timeout to avoid unexpected connection drops
      idleClientTimeout: 15 * 60,
    });

    new rds.CfnDBProxyTargetGroup(this, 'ProxyTargetGroup', {
      dbProxyName: cfnProxy.ref,
      targetGroupName: 'default',
      dbInstanceIdentifiers: [props.primary.instanceIdentifier],
      connectionPoolConfigurationInfo: {
        // borrowTimeout: how long a client waits for a pooled connection before getting an error.
        // The default 120s is often too long. A lower value helps your application "fail fast" and
        // trigger retries rather than hanging during a traffic spike.
        // 30s is a safe default; reduce for latency-sensitive workloads.
        connectionBorrowTimeout: 30,

        // Reserves 10-20% for direct admin access, maintenance tasks, and emergency psql sessions that bypass the proxy.
        // Max Connections managed by Proxy = maxConnectionsPercent * max_connections (a PostgreSQL config parameter that varies by instance size).
        // max_connections is ~112 / 1GiB RAM for PostgreSQL, so a t4g.micro with 1 GiB RAM has max_connections ≈ 100, and the proxy allows up to 90 connections with this setting.
        maxConnectionsPercent: 90,

        // Postgres processes are memory-heavy. Lowering this from the default (50%) aggressively
        // closes inactive backend connections, saving RAM on the DB instance.
        // Keep ≥ 10 — too low causes connection latency spikes on traffic bursts
        maxIdleConnectionsPercent: 10,
      },
    });

    // Read-only endpoint routes to replicas only; default proxy endpoint routes to primary.
    const readOnlyEndpoint = new rds.CfnDBProxyEndpoint(this, 'ReadOnlyEndpoint', {
      dbProxyEndpointName: cdk.Fn.sub('${AWS::StackName}-ro'),
      dbProxyName: cfnProxy.ref,
      vpcSubnetIds: subnetIds,
      vpcSecurityGroupIds: [proxySG.securityGroupId],
      targetRole: 'READ_ONLY',
    });

    new cdk.CfnOutput(this, 'ProxyReadWriteEndpoint', { value: cfnProxy.attrEndpoint });
    new cdk.CfnOutput(this, 'ProxyReadOnlyEndpoint', { value: readOnlyEndpoint.attrEndpoint });
  }
}

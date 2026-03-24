import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3_assets from 'aws-cdk-lib/aws-s3-assets';
import * as path from 'path';
import { execSync } from 'child_process';

export const elasticacheValkeyServerlessAppStackName = 'ElastiCacheValkeyServerlessApp';

interface ElastiCacheValkeyServerlessAppStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  cacheSG: ec2.SecurityGroup;
  appUserSecret: secretsmanager.Secret;
}

// demo_server → SSM port forward (port 3000) → curl/browser
// demo_server → ElastiCache serverless (direct, from within VPC, single hostname, port 6379 reads+writes / 6380 eventually-consistent reads)
export class ElastiCacheValkeyServerlessAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ElastiCacheValkeyServerlessAppStackProps) {
    super(scope, id, props);

    // No inbound rules — accessed only via SSM port-forwarding.
    // Outbound is restricted to what the demo server actually needs.
    const demoServerSG = new ec2.SecurityGroup(this, 'DemoServerSG', {
      vpc: props.vpc,
      description: 'Demo server - no inbound; outbound to ElastiCache and AWS APIs only',
      allowAllOutbound: false,
    });
    // Serverless uses a single hostname on two ports:
    //   6379 — primary port (reads + writes)
    //   6380 — read port (eventually-consistent reads only)
    demoServerSG.addEgressRule(props.cacheSG, ec2.Port.tcp(6379), 'Valkey primary port (reads + writes)');
    demoServerSG.addEgressRule(props.cacheSG, ec2.Port.tcp(6380), 'Valkey read port (eventually-consistent)');
    // SSM agent, Secrets Manager, S3 (asset download), CloudFormation — all over HTTPS.
    demoServerSG.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'AWS APIs');

    // Standalone ingress rules owned by this stack rather than inline on the cache stack's SG.
    // Avoids cross-stack mutation: the CfnSecurityGroupIngress resources live here and
    // reference props.cacheSG.securityGroupId via Fn::ImportValue (app → cache dependency).
    new ec2.CfnSecurityGroupIngress(this, 'CacheAccessPort6379', {
      groupId: props.cacheSG.securityGroupId,
      sourceSecurityGroupId: demoServerSG.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 6379,
      toPort: 6379,
      description: 'Valkey primary from demo server',
    });
    new ec2.CfnSecurityGroupIngress(this, 'CacheAccessPort6380', {
      groupId: props.cacheSG.securityGroupId,
      sourceSecurityGroupId: demoServerSG.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 6380,
      toPort: 6380,
      description: 'Valkey reader from demo server',
    });

    // AmazonSSMManagedInstanceCore allows SSM agent to register and accept port-forward sessions.
    const demoServerRole = new iam.Role(this, 'DemoServerRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });

    // Bundle demo_server.ts into a single JS file with esbuild and upload to S3.
    // The demo server downloads and runs it on startup — no Node modules or TypeScript needed on the instance.
    const demoServerAsset = new s3_assets.Asset(this, 'DemoServerAsset', {
      // Path used for asset fingerprinting; with local bundling, only outputDir is uploaded.
      path: path.join(__dirname),
      bundling: {
        local: {
          tryBundle(outputDir: string): boolean {
            try {
              execSync(
                `npx esbuild demo_server.ts --bundle --platform=node --target=node20 --outfile=${outputDir}/demo_server.js`,
                { stdio: 'inherit', cwd: __dirname },
              );
              return true;
            } catch {
              return false;
            }
          },
        },
        // Docker fallback if esbuild is not available locally.
        image: cdk.DockerImage.fromRegistry('public.ecr.aws/docker/library/node:20-alpine'),
        command: [
          'sh',
          '-c',
          'npx esbuild demo_server.ts --bundle --platform=node --target=node20 --outfile=/asset-output/demo_server.js',
        ],
      },
    });

    // All three grants target demoServerRole, which lives in this stack — no cross-stack IAM cycle.
    demoServerAsset.grantRead(demoServerRole); // server can read S3
    props.appUserSecret.grantRead(demoServerRole); // server can get password from Secrets Manager
    demoServerRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['cloudformation:DescribeStacks'],
        resources: ['*'],
      }),
    );

    // ARM + t4g.nano (~$3/mo). Public subnet: SSM requires internet access; with the default
    // natGateways=0, private subnets have no outbound route to SSM endpoints.
    // Deploy VpcSubnets with -c natGateways=1 to move this to PRIVATE_WITH_EGRESS instead.
    const demoServer = new ec2.Instance(this, 'DemoServer', {
      vpc: props.vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: demoServerSG,
      role: demoServerRole,
      // No SSH key — access is exclusively via SSM port-forwarding.
    });

    // Node.js 20 LTS — installed on first boot via user data.
    demoServer.addUserData('dnf install -y nodejs20', 'ln -sf /usr/bin/node20 /usr/local/bin/node');

    new cdk.CfnOutput(this, 'DemoServerInstanceId', { value: demoServer.instanceId });
    new cdk.CfnOutput(this, 'DemoServerAssetS3Url', { value: demoServerAsset.s3ObjectUrl });
  }
}

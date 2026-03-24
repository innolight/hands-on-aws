import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export const elasticacheValkeyServerlessStackName = 'ElastiCacheValkeyServerless';

interface ElastiCacheValkeyServerlessStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  // ECPUs/sec range controls cost. Minimum 1000 is the AWS floor; raising maxEcpuPerSecond
  // caps runaway spend at the expense of throttling under burst load.
  minEcpuPerSecond?: number;
  maxEcpuPerSecond?: number;
  // GB of in-memory storage. Serverless scales storage automatically up to this cap.
  maxDataStorageGb?: number;
}

// ElastiCache Valkey Serverless (TLS + RBAC) in isolated subnet.
// No node type, no shard count, no parameter group — AWS manages all capacity.
// Access from application tier: add an ingress rule to cacheSG from the app SG.
export class ElastiCacheValkeyServerlessStack extends cdk.Stack {
  public readonly cacheSG: ec2.SecurityGroup;
  public readonly appUserSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: ElastiCacheValkeyServerlessStackProps) {
    super(scope, id, props);

    const minEcpu = props.minEcpuPerSecond ?? 1000;
    const maxEcpu = props.maxEcpuPerSecond ?? 5000;
    const maxStorage = props.maxDataStorageGb ?? 1;

    // Exposed so the app stack can add its own ingress rule from the app server SG.
    this.cacheSG = new ec2.SecurityGroup(this, 'CacheSG', {
      vpc: props.vpc,
      description: 'ElastiCache serverless security group',
      allowAllOutbound: false,
    });

    // The default user must exist and be disabled. ElastiCache requires a default
    // user in every user group; disabling it forces all clients to authenticate
    // via named users (RBAC enforcement).
    // Valkey does not allow noPasswordRequired — a password is required even for
    // disabled users. The password is irrelevant since the user cannot authenticate.
    const defaultUserSecret = new secretsmanager.Secret(this, 'DefaultUserSecret', {
      generateSecretString: { excludePunctuation: true, passwordLength: 32 },
      // !! Change the following in production.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const defaultUser = new elasticache.CfnUser(this, 'DefaultUser', {
      userId: 'valkey-serverless-default',
      userName: 'default',
      engine: 'valkey',
      passwords: [defaultUserSecret.secretValue.unsafeUnwrap()],
      // 'off' disables the user; '-@all' removes all command permissions.
      accessString: 'off ~* -@all',
    });

    // Valkey password constraints: no punctuation allowed.
    this.appUserSecret = new secretsmanager.Secret(this, 'ValkeySecret', {
      description: 'Valkey RBAC password for appuser',
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 32,
      },
      // !! Change the following in production.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    // appuser has full command access (~* +@all). Password is resolved from
    // Secrets Manager at deploy time via dynamic reference.
    const appUser = new elasticache.CfnUser(this, 'AppUser', {
      userId: 'valkey-serverless-appuser',
      userName: 'appuser',
      engine: 'valkey',
      passwords: [this.appUserSecret.secretValue.unsafeUnwrap()],
      accessString: 'on ~* +@all',
    });

    const userGroup = new elasticache.CfnUserGroup(this, 'UserGroup', {
      userGroupId: 'valkey-serverless-usergroup',
      engine: 'valkey',
      userIds: [defaultUser.ref, appUser.ref],
    });

    // CfnServerlessCache does not require a CfnSubnetGroup or CfnParameterGroup.
    // Unlike node-based CfnReplicationGroup, subnets are passed directly and AWS
    // manages all tuning (eviction policy, defrag, slow log, etc.) internally.
    // TLS is always on — cannot be disabled for serverless caches.
    const serverlessCache = new elasticache.CfnServerlessCache(this, 'ServerlessCache', {
      serverlessCacheName: 'valkey-serverless',
      engine: 'valkey',
      majorEngineVersion: '8',
      subnetIds: props.vpc.isolatedSubnets.map((s) => s.subnetId),
      securityGroupIds: [this.cacheSG.securityGroupId],
      userGroupId: userGroup.ref,
      cacheUsageLimits: {
        ecpuPerSecond: {
          minimum: minEcpu,
          maximum: maxEcpu,
        },
        dataStorage: {
          // AWS minimum: 1 GB. Unit must be 'GB'.
          maximum: maxStorage,
          unit: 'GB',
        },
      },
      // !! Change the following in production.
      // snapshotRetentionLimit: 0 disables automatic snapshots — no final snapshot on delete.
      snapshotRetentionLimit: 0,
    });
    serverlessCache.addDependency(userGroup);

    // Serverless exposes a single hostname on two ports: 6379 (reads + writes) and 6380 (eventually-consistent reads only).
    // Unlike node-based cluster mode, there are no individual shard nodes to discover —
    // the client uses cluster protocol and AWS routes transparently.
    // ValkeyEndpoint and ValkeyReaderEndpoint resolve to the same address; the port differentiates them.
    // Use attrEndpointAddress/attrEndpointPort (not attrEndpoint — that's a composite object, not a string).
    new cdk.CfnOutput(this, 'ValkeyEndpoint', {
      value: serverlessCache.attrEndpointAddress,
    });
    new cdk.CfnOutput(this, 'ValkeyReaderEndpoint', {
      value: serverlessCache.attrReaderEndpointAddress,
    });
    new cdk.CfnOutput(this, 'ValkeyPort', {
      value: serverlessCache.attrEndpointPort,
    });
    new cdk.CfnOutput(this, 'ValkeyReaderPort', {
      value: serverlessCache.attrReaderEndpointPort,
    });
    new cdk.CfnOutput(this, 'ValkeySecretArn', {
      value: this.appUserSecret.secretArn,
    });
  }
}

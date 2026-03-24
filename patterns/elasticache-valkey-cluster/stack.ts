import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export const elasticacheValkeyClusterStackName = 'ElastiCacheValkeyCluster';

interface ElastiCacheValkeyClusterStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
}

// ElastiCache Valkey cluster (sharded, TLS + RBAC) in isolated subnet.
// Access from application tier: add an ingress rule to cacheSG from the app SG.
export class ElastiCacheValkeyClusterStack extends cdk.Stack {
  public readonly cacheSG: ec2.SecurityGroup;
  public readonly appUserSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: ElastiCacheValkeyClusterStackProps) {
    super(scope, id, props);

    // shards controls numNodeGroups — each shard owns a contiguous range of hash slots (0–16383).
    // replicas controls replicasPerNodeGroup — replicas per shard for read scaling and HA.
    const shards = Number(this.node.tryGetContext('shards') || '2');
    const replicas = Number(this.node.tryGetContext('replicas') || '0');

    // Exposed so the app stack can add its own ingress rule from the app server SG.
    this.cacheSG = new ec2.SecurityGroup(this, 'CacheSG', {
      vpc: props.vpc,
      description: 'ElastiCache security group',
      allowAllOutbound: false,
    });

    const subnetGroup = new elasticache.CfnSubnetGroup(this, 'SubnetGroup', {
      description: 'Private isolated subnets for ElastiCache',
      subnetIds: props.vpc.isolatedSubnets.map((s) => s.subnetId),
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
      userId: 'valkey-cluster-default',
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
      userId: 'valkey-cluster-appuser',
      userName: 'appuser',
      engine: 'valkey',
      passwords: [this.appUserSecret.secretValue.unsafeUnwrap()],
      accessString: 'on ~* +@all',
    });

    const userGroup = new elasticache.CfnUserGroup(this, 'UserGroup', {
      userGroupId: 'valkey-cluster-usergroup',
      engine: 'valkey',
      userIds: [defaultUser.ref, appUser.ref],
    });

    const paramGroup = new elasticache.CfnParameterGroup(this, 'ParamGroup', {
      cacheParameterGroupFamily: 'valkey8',
      description: 'Valkey cluster tuning',
      properties: parameterGroupConfig,
    });

    const replicationGroup = new elasticache.CfnReplicationGroup(this, 'ReplicationGroup', {
      replicationGroupId: `valkey-sharded-cluster`,
      replicationGroupDescription: `Valkey cluster: ${shards} shards, ${replicas} replica(s) per shard`,
      engine: 'valkey',
      engineVersion: '8.2', // To use version 9 when available, which improve reliability during resharding scenario.
      cacheNodeType: 'cache.t4g.micro',
      // clusterMode is inferred from numNodeGroups being set, but stated explicitly for clarity.
      clusterMode: 'enabled',
      numNodeGroups: shards,
      replicasPerNodeGroup: replicas,
      // Automatic failover is required for cluster mode (numNodeGroups > 1).
      automaticFailoverEnabled: true,
      // Multi-AZ spreads replicas across AZs; requires at least one replica per shard.
      multiAzEnabled: replicas > 0,
      cacheSubnetGroupName: subnetGroup.ref,
      cacheParameterGroupName: paramGroup.ref,
      securityGroupIds: [this.cacheSG.securityGroupId],
      transitEncryptionEnabled: true,
      atRestEncryptionEnabled: true,
      userGroupIds: [userGroup.ref],
      // !! Change the following in production.
      // snapshotRetentionLimit: 0 disables automatic snapshots — no final snapshot on delete.
      snapshotRetentionLimit: 0,
    });
    replicationGroup.addDependency(userGroup);
    // UseOnlineResharding tells CloudFormation to call ModifyReplicationGroupShardConfiguration
    // instead of replacing the resource when numNodeGroups changes.
    replicationGroup.cfnOptions.updatePolicy = {
      useOnlineResharding: true,
    };

    // attrConfigurationEndPointAddress is the single entry point for cluster-mode clients.
    // Unlike non-cluster mode (primary + reader endpoints), the config endpoint routes
    // to any node; the client then fetches the full slot map via CLUSTER SLOTS.
    new cdk.CfnOutput(this, 'ValkeyConfigEndpoint', {
      value: replicationGroup.attrConfigurationEndPointAddress,
    });
    new cdk.CfnOutput(this, 'ValkeyPort', {
      value: replicationGroup.attrConfigurationEndPointPort,
    });
    new cdk.CfnOutput(this, 'ValkeySecretArn', {
      value: this.appUserSecret.secretArn,
    });
    new cdk.CfnOutput(this, 'ShardCount', {
      value: String(shards),
    });
    new cdk.CfnOutput(this, 'ReplicasPerShard', {
      value: String(replicas),
    });
  }
}

const parameterGroupConfig = {
  // What to do when maxmemory is reached. Default: noeviction (returns error).
  // Pick based on whether all keys or only TTL-tagged keys are safe to evict:
  //
  //   noeviction      — never evict; writes fail when full. Use when data loss is
  //                     unacceptable (e.g. session store with no other persistence).
  //   allkeys-lru     — evict the least-recently-used key across ALL keys.
  //                     Best for a pure cache where every key is equally evictable.
  //   allkeys-lfu     — evict the least-frequently-used key across ALL keys.
  //                     Better than lru when access is skewed (hot/cold data) because
  //                     a key accessed once an hour won't survive just because it was
  //                     touched recently.
  //   allkeys-random  — evict a random key. Rarely the right choice.
  //   volatile-lru    — LRU among keys that have a TTL set. Use when you mix
  //                     ephemeral (TTL) and persistent (no-TTL) keys in one instance.
  //   volatile-lfu    — LFU among TTL-tagged keys.
  //   volatile-random — random among TTL-tagged keys.
  //   volatile-ttl    — evict the key closest to expiry. Good when the TTL value
  //                     itself encodes how disposable the data is.
  'maxmemory-policy': 'allkeys-lru',

  // Number of keys sampled when approximating LRU/LFU. Default: 5.
  // Higher = more accurate eviction at the cost of CPU. 10 is a good compromise;
  // 3 is faster but noticeably less accurate.
  'maxmemory-samples': '5',

  // How fast the LFU access counter decays over time (minutes). Default: 1.
  // Lower = decays faster → LFU tracks recent frequency more tightly.
  // Only relevant when maxmemory-policy includes 'lfu'.
  'lfu-decay-time': '1',

  // Online memory defragmentation — reclaims fragmented memory without a restart.
  // Default: no. Enable on long-running instances with high churn (lots of
  // set/delete cycles) where RSS >> used_memory in INFO memory output.
  activedefrag: 'no',

  // Close idle client connections after N seconds. Default: 0 (disabled).
  // Set to a non-zero value (e.g. 300) to prevent connection leaks from
  // clients that disconnect without closing gracefully.
  timeout: '0',

  // Log commands slower than N microseconds. Default: 10000 (10ms).
  // Retrieve with: SLOWLOG GET 10 — returns the last 10 slow commands.
  'slowlog-log-slower-than': '5000',

  // Maximum number of entries in the slow log. Default: 128.
  // Oldest entries are dropped when the limit is reached.
  'slowlog-max-len': '128',

  // Replication backlog buffer. Default: 1048576 (1 MB).
  // Gives replicas time to catch up after a brief disconnect without triggering
  // a full resync. Increase for high-write workloads where replicas fall behind quickly.
  'repl-backlog-size': '10485760',

  // Allow reads on a shard even when it has lost contact with a majority of masters.
  // Tradeoff: availability over consistency — clients may read stale data during a
  // partition. The alternative (no) returns CLUSTERDOWN errors, rejecting all reads
  // on affected shards. For a demo cache, availability is preferred.
  'cluster-allow-reads-when-down': 'yes',

  // Note: appendonly/appendfsync are NOT configurable via ElastiCache parameter groups —
  // the API rejects them with "parameter cannot be modified". AOF is unsupported in ElastiCache.

  'cluster-enabled': 'yes',
};

import express from 'express';
import {Cluster} from 'iovalkey';
import {SecretsManagerClient, GetSecretValueCommand} from '@aws-sdk/client-secrets-manager';
import {getStackOutputs} from '../../utils';
import {elasticacheValkeyClusterStackName} from './stack';

// Demo server for ElastiCache Valkey cluster (sharded) pattern.
// Runs on a dedicated EC2 inside the VPC — connects directly to the config endpoint.
// No SSM tunnels or natMap needed: the Cluster client reaches all shard nodes directly.
// dnsLookup passes hostnames through without resolving to IPs, so TLS SNI matches the cert.
//
// On the bastion:
//   aws s3 cp <DemoServerAssetS3Url> /tmp/bundle.zip && unzip /tmp/bundle.zip -d /tmp/demo/
//   node /tmp/demo/demo_server.js
const app = express();
const PORT = process.env.PORT || 3000;

let cluster: Cluster;

(async () => {
  const outputs = await getStackOutputs(elasticacheValkeyClusterStackName);
  console.log(`StackOutputs for ${elasticacheValkeyClusterStackName}:`, outputs);

  const configEndpoint = outputs['ValkeyConfigEndpoint'];
  const secretArn = outputs['ValkeySecretArn'];
  const region = process.env.AWS_REGION || 'eu-central-1';

  const smClient = new SecretsManagerClient({region});
  const secretResult = await smClient.send(new GetSecretValueCommand({SecretId: secretArn}));
  const password = secretResult.SecretString!;

  // Connect via the config endpoint — the Cluster client fetches the full slot map
  // via CLUSTER SLOTS and routes subsequent commands to the correct shard automatically.
  cluster = new Cluster([{host: configEndpoint, port: 6379}], {
    // dnsLookup overrides
    // - Without it: dns.lookup() resolves the node hostname to an IP → TCP connects to the IP → TLS has no hostname for SNI → cert validation fails
    // - With it: hostname passes through unchanged → TLS SNI uses the real hostname → cert matches → validation succeeds
    dnsLookup: (address, callback) => callback(null, address),
    redisOptions: {
      // username & password required for RBAC
      username: 'appuser', password, 
      // tls: {} uses Node's default CA store, which trusts AWS's cert.
      tls: {},
      socketTimeout: 1000,
      commandTimeout: 1000,
      connectTimeout: 2000,
      // Max reconnection retry attempts due to lost connection. Default 20 can cause long hangs during outages.
      // Tune together with retryDelayOnFailover to cover failover scenarios without downtime.
      maxRetriesPerRequest: 2,
      // offlineQueue controls whether commands are buffered while the client is disconnected
      // offlineQueue = false -> commands fail immediately when disconnected instead of queuing them.
      //  = true  -> risks unbounded memory growth if the queue fills during an extended outage.
      offlineQueue: false,
    },
    // ms to wait before retrying a command after a MOVED redirect during failover.
    retryDelayOnFailover: 300,
    // ms to wait before retrying when the cluster reports CLUSTERDOWN.
    retryDelayOnClusterDown: 300,
    // Where to route read commands.
    //    'master' = consistent reads from primary.
    //    'slave' = lower latency if replicas exist; may return stale data.
    //    'all' = round-robin between primary and replicas; may return stale data.
    scaleReads: 'all',
  });

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
})();

// GET /set?key=x&value=y — the Cluster client routes the command to the correct shard
app.get('/set', async (req, res) => {
  const {key, value} = req.query as {key: string; value: string};
  if (!key || value === undefined) {
    res.status(400).json({error: 'key and value are required'});
    return;
  }
  try {
    await cluster.set(key, value);
    res.json({ok: true, key, value, slot: keyHashSlot(key)});
  } catch (err) {
    console.error(err);
    res.status(500).json({error: String(err)});
  }
});

// GET /get?key=x
app.get('/get', async (req, res) => {
  const {key} = req.query as {key: string};
  if (!key) {
    res.status(400).json({error: 'key is required'});
    return;
  }
  try {
    const value = await cluster.get(key);
    res.json({key, value, slot: keyHashSlot(key)});
  } catch (err) {
    console.error(err);
    res.status(500).json({error: String(err)});
  }
});

// GET /keys — scans all master nodes and merges results.
// !! Never use KEYS in production — it blocks the server for the full scan duration.
app.get('/keys', async (_req, res) => {
  try {
    const masters = cluster.nodes('master');
    const allKeys = await Promise.all(masters.map(node => node.keys('*')));
    res.json({keys: allKeys.flat()});
  } catch (err) {
    console.error(err);
    res.status(500).json({error: String(err)});
  }
});

// GET /del?key=x
app.get('/del', async (req, res) => {
  const {key} = req.query as {key: string};
  if (!key) {
    res.status(400).json({error: 'key is required'});
    return;
  }
  try {
    const deleted = await cluster.del(key);
    res.json({key, deleted});
  } catch (err) {
    console.error(err);
    res.status(500).json({error: String(err)});
  }
});

// GET /info — replication info for each master node.
// Shows role, connected replicas, replication offset, and lag per shard.
app.get('/info', async (_req, res) => {
  try {
    const masters = cluster.nodes('master');
    const infos = await Promise.all(masters.map(node => node.info('replication')));
    res.json(infos.map((info, i) => ({shard: i, info})));
  } catch (err) {
    console.error(err);
    res.status(500).json({error: String(err)});
  }
});

// GET /slot?key=x — shows which hash slot and approximate shard a key maps to.
// Educational: demonstrates how cluster mode distributes keys across shards.
// Hash tags: keys sharing a {tag} all map to the same slot, enabling multi-key commands.
app.get('/slot', async (req, res) => {
  const {key} = req.query as {key: string};
  if (!key) {
    res.status(400).json({error: 'key is required'});
    return;
  }
  const slot = keyHashSlot(key);
  const masters = cluster.nodes('master');
  // Approximate shard: each shard owns ~16384/N slots, assigned in ascending order.
  // The actual assignment comes from CLUSTER SLOTS but this is close enough for demos.
  const shardIndex = Math.floor((slot / 16384) * masters.length);
  const hashTag = key.match(/\{([^}]+)\}/)?.[1];
  res.json({
    key,
    slot,
    totalSlots: 16384,
    shardIndex,
    shardCount: masters.length,
    ...(hashTag ? {hashTag, note: `only "${hashTag}" is hashed — keys with the same tag share this slot`} : {}),
  });
});

// CRC-16/CCITT polynomial — the same algorithm Redis/Valkey uses to assign keys to slots.
const CRC16_LOOKUP: number[] = (() => {
  const t: number[] = [];
  for (let i = 0; i < 256; i++) {
    let crc = i << 8;
    for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
    t.push(crc & 0xffff);
  }
  return t;
})();

function keyHashSlot(key: string): number {
  // If the key contains {tag}, only the tag content is hashed.
  // This lets application code co-locate related keys on the same shard.
  let toHash = key;
  const open = key.indexOf('{');
  if (open !== -1) {
    const close = key.indexOf('}', open + 1);
    if (close > open + 1) toHash = key.slice(open + 1, close);
  }
  let crc = 0;
  for (let i = 0; i < toHash.length; i++) {
    crc = (CRC16_LOOKUP[(crc >> 8) ^ toHash.charCodeAt(i)] ^ (crc << 8)) & 0xffff;
  }
  return crc % 16384;
}

import express from 'express';
import {Cluster} from 'iovalkey';
import {SecretsManagerClient, GetSecretValueCommand} from '@aws-sdk/client-secrets-manager';
import {getStackOutputs} from '../../utils';
import {elasticacheValkeyServerlessStackName} from './stack';

// Demo server for ElastiCache Valkey Serverless pattern.
// Runs on a dedicated EC2 inside the VPC — connects to a single endpoint hostname (port 6379 writes, 6380 reads).
// dnsLookup passes hostnames through without resolving to IPs, so TLS SNI matches the cert.
// Demonstrates: retry with exponential backoff + jitter, and command pipelining.
//
// On the EC2 instance:
//   aws s3 cp <DemoServerAssetS3Url> /tmp/bundle.zip && unzip /tmp/bundle.zip -d /tmp/demo/
//   node /tmp/demo/demo_server.js
const app = express();
const PORT = process.env.PORT || 3000;

let cluster: Cluster;

(async () => {
  const outputs = await getStackOutputs(elasticacheValkeyServerlessStackName);
  console.log(`StackOutputs for ${elasticacheValkeyServerlessStackName}:`, outputs);

  const endpoint = outputs['ValkeyEndpoint'];
  const secretArn = outputs['ValkeySecretArn'];
  const region = process.env.AWS_REGION || 'eu-central-1';

  const smClient = new SecretsManagerClient({region});
  const secretResult = await smClient.send(new GetSecretValueCommand({SecretId: secretArn}));
  const password = secretResult.SecretString!;
  
  // Serverless exposes a single hostname on two ports:
  //   6379 — primary port, handles both reads and writes
  //   6380 — read port, lower-latency eventually-consistent reads via READONLY command
  // The Cluster client uses cluster-mode protocol — required for serverless, which presents
  // as a cluster regardless of the underlying topology.
  //
  // First, we connect to port 6379 (primary). The client then issues CLUSTER SLOTS to discover
  // the full topology; AWS returns port 6380 reader addresses as replica slots.
  // With scaleReads: 'slave', read commands are routed to those discovered addresses —
  // port 6380 is used automatically without being configured here explicitly.
  cluster = new Cluster([{host: endpoint, port: 6379}], {
    // dnsLookup passes hostnames through unchanged so TLS SNI matches the server cert.
    // Without it, dns.lookup() resolves to an IP → TLS has no hostname → cert validation fails.
    dnsLookup: (address, callback) => callback(null, address),
    redisOptions: {
      username: 'appuser', password,
      // tls: {} uses Node's default CA store, which trusts AWS's cert.
      tls: {},
      maxRetriesPerRequest: 3,
      // offlineQueue = false: commands fail immediately when disconnected instead of
      // queuing them. Queue = true risks unbounded memory growth during extended outages.
      offlineQueue: false,
      connectTimeout: 2000,
      commandTimeout: 1000,
      socketTimeout: 1000,
    },
    // Exponential backoff + jitter on cluster reconnection. Avoids thundering herd when
    // all clients reconnect simultaneously after a transient failure.
    // delay = min(attempt * 200ms, 3000ms) + random(0..100ms)
    clusterRetryStrategy(times: number) {
      const delay = Math.min(times * 200, 3000);
      const jitter = Math.random() * 100;
      return delay + jitter;
    },
    // ms to wait before retrying a command after a MOVED redirect during failover.
    retryDelayOnFailover: 300,
    // ms to wait before retrying when the cluster reports CLUSTERDOWN.
    retryDelayOnClusterDown: 300,
    
    // Route reads to both primary and reader endpoints
    scaleReads: 'all',
  });

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
})();

// GET /set?key=x&value=y
app.get('/set', async (req, res) => {
  const {key, value} = req.query as {key: string; value: string};
  if (!key || value === undefined) {
    res.status(400).json({error: 'key and value are required'});
    return;
  }
  try {
    await cluster.set(key, value);
    res.json({ok: true, key, value});
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
    res.json({key, value});
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

// GET /pipeline?n=N — runs N SET commands both sequentially and via pipeline().
// Returns timing comparison (ms) to demonstrate the concrete latency benefit of batching.
//
// Without pipeline: each SET is a full round trip → N * RTT total latency.
// With pipeline: all N SETs are sent in one batch → ~1 RTT regardless of N.
// The speedup is most visible with N=100+ and network latency > 1ms.
app.get('/pipeline', async (req, res) => {
  const n = Math.min(Number(req.query.n) || 10, 500);

  try {
    // Sequential: N individual round trips
    const seqStart = Date.now();
    for (let i = 0; i < n; i++) {
      await cluster.set(`seq:key:${i}`, `value${i}`);
    }
    const seqMs = Date.now() - seqStart;

    // Pipelined: all N commands sent in a single batch
    const pipeStart = Date.now();
    const pipe = cluster.pipeline();
    for (let i = 0; i < n; i++) {
      pipe.set(`pipe:key:${i}`, `value${i}`);
    }
    await pipe.exec();
    const pipeMs = Date.now() - pipeStart;

    res.json({
      n,
      sequential_ms: seqMs,
      pipeline_ms: pipeMs,
      speedup: `${(seqMs / pipeMs).toFixed(1)}x`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({error: String(err)});
  }
});

// GET /info — server info, connection status, and cluster slot topology.
// CLUSTER SLOTS shows which ports AWS advertised as primary vs reader slots,
// confirming that port 6380 was discovered dynamically (not configured explicitly).
app.get('/info', async (_req, res) => {
  try {
    const nodes = cluster.nodes('all');
    const [serverInfos, replInfos, slots] = await Promise.all([
      Promise.all(nodes.map(node => node.info('server'))),
      Promise.all(nodes.map(node => node.info('replication'))),
      nodes[0].call('CLUSTER', 'SLOTS'),
    ]);
    res.json({
      connectedNodes: nodes.length,
      nodes: serverInfos.map((info, i) => ({node: i, server: info, replication: replInfos[i]})),
      clusterSlots: slots,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({error: String(err)});
  }
});

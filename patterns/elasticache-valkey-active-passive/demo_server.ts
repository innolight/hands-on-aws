import express from 'express';
import Valkey from 'iovalkey';
import {SecretsManagerClient, GetSecretValueCommand} from '@aws-sdk/client-secrets-manager';
import {getStackOutputs} from '../../utils';
import {elasticacheValkeyActivePassiveStackName} from './stack';

// Demo server for ElastiCache Valkey pattern.
// Uses two clients (RW + RO) to show the client-side best practice:
// when scaling from 1→N nodes, zero code changes needed.
//
// Requires two SSM port-forward tunnels:
//   local 6379 → primary endpoint (RW)
//   local 6380 → reader endpoint (RO)
//
// Run: AWS_REGION=eu-central-1 npx ts-node patterns/elasticache-valkey-active-passive/demo_server.ts
const app = express();
const PORT = process.env.PORT || 3000;

let rwClient: Valkey;
let roClient: Valkey;

(async () => {
  const outputs = await getStackOutputs(elasticacheValkeyActivePassiveStackName);
  console.log(`StackOutputs for ${elasticacheValkeyActivePassiveStackName}:`, outputs);

  const primaryEndpoint = outputs['ValkeyPrimaryEndpoint'];
  const readerEndpoint = outputs['ValkeyReaderEndpoint'];
  const secretArn = outputs['ValkeySecretArn'];
  const region = process.env.AWS_REGION || 'eu-central-1';

  // Retrieve the Valkey password from Secrets Manager at startup.
  const smClient = new SecretsManagerClient({region});
  const secretResult = await smClient.send(new GetSecretValueCommand({SecretId: secretArn}));
  const password = secretResult.SecretString!;

  const tlsOptions = (servername: string) => ({
    // servername is required so the TLS client sends SNI matching the ElastiCache
    // certificate CN, even though the TCP connection goes to localhost (SSM tunnel).
    tls: {servername},
  });

  // RW client connects to local port 6379 (SSM tunnel to primary endpoint).
  rwClient = new Valkey({
    host: 'localhost',
    port: 6379,
    username: 'appuser',
    password,
    ...tlsOptions(primaryEndpoint),
  });

  // RO client connects to local port 6380 (SSM tunnel to reader endpoint).
  // When nodes=1, the reader endpoint resolves to the same node — both clients
  // hit the same instance, so behaviour is identical.
  roClient = new Valkey({
    host: 'localhost',
    port: 6380,
    username: 'appuser',
    password,
    ...tlsOptions(readerEndpoint),
  });

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Primary (RW): localhost:6379 → ${primaryEndpoint}`);
    console.log(`Reader  (RO): localhost:6380 → ${readerEndpoint}`);
  });
})();

// GET /set?key=x&value=y — write via primary (RW client)
app.get('/set', async (req, res) => {
  const {key, value} = req.query as {key: string; value: string};
  if (!key || value === undefined) {
    res.status(400).json({error: 'key and value are required'});
    return;
  }
  try {
    await rwClient.set(key, value);
    res.json({ok: true, key, value});
  } catch (err) {
    console.error(err);
    res.status(500).json({error: String(err)});
  }
});

// GET /get?key=x — read via reader (RO client); may return stale data under replication lag
app.get('/get', async (req, res) => {
  const {key} = req.query as {key: string};
  if (!key) {
    res.status(400).json({error: 'key is required'});
    return;
  }
  try {
    const value = await roClient.get(key);
    res.json({key, value});
  } catch (err) {
    console.error(err);
    res.status(500).json({error: String(err)});
  }
});

// GET /keys — list all keys via reader (RO client).
// !! Never use KEYS in production — it blocks the server for the full scan duration.
// Use SCAN with a cursor for production key enumeration.
app.get('/keys', async (_req, res) => {
  try {
    const keys = await roClient.keys('*');
    res.json({keys});
  } catch (err) {
    console.error(err);
    res.status(500).json({error: String(err)});
  }
});

// GET /del?key=x — delete via primary (RW client)
app.get('/del', async (req, res) => {
  const {key} = req.query as {key: string};
  if (!key) {
    res.status(400).json({error: 'key is required'});
    return;
  }
  try {
    const deleted = await rwClient.del(key);
    res.json({key, deleted});
  } catch (err) {
    console.error(err);
    res.status(500).json({error: String(err)});
  }
});

// GET /info — connection status + INFO replication output.
// Shows replication role, connected replicas, replication offset, and replica lag.
// Useful for observing whether replicas are in sync with the primary.
app.get('/info', async (_req, res) => {
  try {
    const [primaryInfo, readerInfo] = await Promise.all([
      rwClient.info('replication'),
      roClient.info('replication'),
    ]);
    res.json({
      rwClient: {host: 'localhost', port: 6379, info: primaryInfo},
      roClient: {host: 'localhost', port: 6380, info: readerInfo},
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({error: String(err)});
  }
});

// GET /write-read-test — demonstrates eventual consistency / replication lag.
// Writes a timestamped key via the RW client, then immediately reads via the
// RO client. If the replica hasn't caught up yet, the value will be null —
// showing that reads on the reader endpoint can be stale immediately after a write.
app.get('/write-read-test', async (_req, res) => {
  const key = `write-read-test:${Date.now()}`;
  const value = `written-at-${new Date().toISOString()}`;
  try {
    await rwClient.set(key, value);
    const readValue = await roClient.get(key);
    res.json({
      key,
      written: value,
      readFromReplica: readValue,
      // null means the replica hadn't propagated the write yet
      replicated: readValue !== null,
    });
    // Clean up test key
    await rwClient.del(key);
  } catch (err) {
    console.error(err);
    res.status(500).json({error: String(err)});
  }
});

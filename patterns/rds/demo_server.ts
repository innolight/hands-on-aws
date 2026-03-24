import express from 'express';
import { Pool, PoolConfig } from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { getStackOutputs } from '../../utils';
import { rdsPostgresStackName } from './rds-postgres/stack';
import { rdsReadableStandbysStackName } from './rds-readable-standbys/stack';
import { rdsReadReplicasStackName } from './rds-read-replicas/stack';
import { rdsAuroraProvisionedStackName } from './rds-aurora-provisioned/stack';

// Shared demo server for all RDS PostgreSQL patterns.
// Demonstrates two clients (RW + RO) and client-side best practices.
//
// Usage:
//   AWS_REGION=eu-central-1 npx ts-node patterns/rds/demo_server.ts rds-postgres
//   AWS_REGION=eu-central-1 npx ts-node patterns/rds/demo_server.ts rds-read-replicas
//   AWS_REGION=eu-central-1 npx ts-node patterns/rds/demo_server.ts rds-readable-standbys
//   AWS_REGION=eu-central-1 npx ts-node patterns/rds/demo_server.ts rds-aurora-provisioned
//
// Requires SSM port-forward tunnels before starting:
//   localhost:5432 -> RW endpoint (writer / primary / proxy)
//   localhost:5433 -> RO endpoint (reader / replica) — same port as RW for rds-postgres

type PatternName = 'rds-postgres' | 'rds-read-replicas' | 'rds-readable-standbys' | 'rds-aurora-provisioned';

interface PatternConfig {
  // StackName is used to fetc outputs "SecretArn", and "DatabaseName"
  stackName: string;
  // Local tunnel ports. Use the same port for both when the pattern has a single endpoint.
  rwTunnelPort: number;
  roTunnelPort: number;
}

const PATTERNS: Record<PatternName, PatternConfig> = {
  // rds-postgres: both clients connect through the proxy (single endpoint).
  // The proxy already pools connections and reduces failover time.
  'rds-postgres': {
    stackName: rdsPostgresStackName,
    rwTunnelPort: 5432,
    roTunnelPort: 5432,
  },
  // rds-read-replicas: proxy RW endpoint for writes, proxy RO endpoint for reads (async, may be stale).
  'rds-read-replicas': {
    stackName: rdsReadReplicasStackName,
    rwTunnelPort: 5432,
    roTunnelPort: 5433,
  },
  // rds-readable-standbys: writer endpoint for writes, reader endpoint for reads (sync).
  'rds-readable-standbys': {
    stackName: rdsReadableStandbysStackName,
    rwTunnelPort: 5432,
    roTunnelPort: 5433,
  },
  // rds-aurora-provisioned: writer endpoint for writes, reader endpoint for reads (zero-lag, shared storage).
  'rds-aurora-provisioned': {
    stackName: rdsAuroraProvisionedStackName,
    rwTunnelPort: 5432,
    roTunnelPort: 5433,
  },
};

const patternName = process.argv[2] as PatternName;
if (!PATTERNS[patternName]) {
  console.error(`Usage: npx ts-node patterns/rds/demo_server.ts <pattern-name>`);
  console.error(`  Patterns: ${Object.keys(PATTERNS).join(', ')}`);
  process.exit(1);
}

const pattern = PATTERNS[patternName];
const region = process.env.AWS_REGION || 'eu-central-1';
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());

let rwPool: Pool;
let roPool: Pool;

(async () => {
  const outputs = await getStackOutputs(pattern.stackName);
  console.log(`Stack outputs for ${pattern.stackName}:`, outputs);

  const secretArn = outputs['SecretArn'];
  const dbName = outputs['DatabaseName'] ?? 'demo';

  // Fetch credentials from Secrets Manager. The managed secret contains {username, password}.
  // Endpoint and port come from stack outputs (not the secret) because the managed-password
  // secret format omits host/port.
  const smClient = new SecretsManagerClient({ region });
  const secretResult = await smClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
  const secret = JSON.parse(secretResult.SecretString!);
  const creds = { user: secret.username, password: secret.password, database: dbName };

  const rwPoolConfig = makePoolConfig(pattern.rwTunnelPort, creds);
  const roPoolConfig = makePoolConfig(pattern.roTunnelPort, creds);

  rwPool = new Pool(rwPoolConfig);
  roPool = new Pool(roPoolConfig);

  // Create the quotes table on startup if it doesn't already exist.
  await withRetry(() =>
    rwPool.query(`
      CREATE TABLE IF NOT EXISTS quotes (
        id         SERIAL PRIMARY KEY,
        text       TEXT NOT NULL,
        author     TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `),
  );

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Pattern:  ${patternName}`);
    console.log(`RW pool:  localhost:${pattern.rwTunnelPort}`);
    console.log(`RO pool:  localhost:${pattern.roTunnelPort}`);
  });
})();

// POST /quotes — write a quote via RW pool
// Body: { "text": "The only way to do great work is to love what you do.", "author": "Steve Jobs" }
app.post('/quotes', async (req, res) => {
  const { text, author } = req.body as { text?: string; author?: string };
  if (!text) {
    res.status(400).json({ error: 'text is required' });
    return;
  }
  try {
    const result = await withRetry(() =>
      rwPool.query('INSERT INTO quotes (text, author) VALUES ($1, $2) RETURNING *', [text, author ?? null]),
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// GET /quotes — read all quotes via RO pool
app.get('/quotes', async (_req, res) => {
  try {
    const result = await withRetry(() => roPool.query('SELECT * FROM quotes ORDER BY created_at DESC'));
    res.json({
      quotes: result.rows,
      // endpoint shows which pool served the read — useful for verifying that
      // read traffic is actually routed to the replica/reader endpoint.
      endpoint: `localhost:${pattern.roTunnelPort}`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// GET /health — ping both pools; shows pool stats
app.get('/health', async (_req, res) => {
  const check = async (pool: Pool, label: string) => {
    try {
      await pool.query('SELECT 1');
      return {
        status: 'ok',
        label,
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      };
    } catch (err) {
      return { status: 'error', label, error: String(err) };
    }
  };
  const [rw, ro] = await Promise.all([
    check(rwPool, `rw localhost:${pattern.rwTunnelPort}`),
    check(roPool, `ro localhost:${pattern.roTunnelPort}`),
  ]);
  const ok = rw.status === 'ok' && ro.status === 'ok';
  res.status(ok ? 200 : 503).json({ rw, ro });
});

// GET /write-read-test — writes a quote via RW, immediately reads via RO.
// For rds-read-replicas (async replication): the read may return null for the new
// row because the replica hasn't caught up yet. This demonstrates the trade-off of
// async replication: higher throughput, but reads can be stale immediately after writes.
// For rds-readable-standbys (sync replication): the read always sees the write.
app.get('/write-read-test', async (_req, res) => {
  const text = `test-${Date.now()}`;
  try {
    const writeResult = await withRetry(() =>
      rwPool.query('INSERT INTO quotes (text, author) VALUES ($1, $2) RETURNING id', [text, 'write-read-test']),
    );
    const { id } = writeResult.rows[0];

    const readResult = await withRetry(() => roPool.query('SELECT * FROM quotes WHERE id = $1', [id]));
    const found = readResult.rows.length > 0;

    // Clean up the test row via RW pool.
    await withRetry(() => rwPool.query('DELETE FROM quotes WHERE id = $1', [id]));

    res.json({
      id,
      written: text,
      readFromRoPool: found ? readResult.rows[0] : null,
      // replicated=false means the replica hadn't propagated the write yet.
      replicated: found,
      pattern: patternName,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// Wraps a pool query with retry logic for transient connection errors.
// During RDS failover, connections fail with ECONNRESET or error code 57P01
// (admin_shutdown) before the DNS flips to the new primary. Retrying up to 3
// times with a 1s delay covers the reconnect window without stalling the request.
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  const retryable = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT']);
  const retryablePgCodes = new Set([
    '57P01', // admin_shutdown
    '08006', // connection_failure
    '08001', // sqlclient_unable_to_establish_sqlconnection
  ]);
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException & { code?: string };
      const isRetryable = retryable.has(e.code ?? '') || retryablePgCodes.has(e.code ?? '');
      if (!isRetryable || i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('unreachable');
}

function makePoolConfig(tunnelPort: number, creds: { user: string; password: string; database: string }): PoolConfig {
  return {
    host: 'localhost',
    port: tunnelPort,
    user: creds.user,
    password: creds.password,
    database: creds.database,
    // RDS requires SSL. rejectUnauthorized=false allows the SSM tunnel where the
    // TLS certificate CN is the RDS endpoint, not localhost.
    ssl: { rejectUnauthorized: false },

    // -- Pool sizing --
    // max: upper bound on open connections per pool. Each pool (RW + RO) holds up to
    // this many. Keep below max_connections on the DB instance:
    //   t4g.micro: ~112 max_connections; 8 per pool leaves room for other clients.
    max: 8,
    // min: connections held open even when idle. Avoids cold-connect latency on
    // the first request after a quiet period.
    min: 2,
    // idleTimeoutMillis: close a connection that has been idle this long.
    // Prevents accumulation of stale connections on the DB side.
    idleTimeoutMillis: 30_000,

    // -- Failover-friendly settings --
    // connectionTimeoutMillis: give up trying to connect after this many ms.
    // The pg default is effectively infinite. 5s fails fast during failover so
    // the retry loop above can fire before the caller times out.
    connectionTimeoutMillis: 5_000,

    // statement_timeout not supported by RDS Proxy
    // statement_timeout: cancel any query running longer than this (ms).
    // Prevents a runaway query from blocking the pool during a failover event.
    // statement_timeout is a PostgreSQL parameter sent at connection time.
    // statement_timeout: 10_000,

    // query_timeout is the pg driver-level guard (no round-trip needed).
    query_timeout: 10_000,

    // -- TCP keepalives detect dead connections sooner than the OS default (2h) --
    // Without keepalives, a connection to a failed DB instance appears healthy
    // until a query attempt fails. Keepalives probe every 10s after 10s idle,
    // so dead connections are detected within ~30s instead of hours.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  };
}

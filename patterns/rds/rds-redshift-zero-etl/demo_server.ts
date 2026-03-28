import express from 'express';
import { Pool } from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
  RedshiftDataClient,
  ExecuteStatementCommand,
  DescribeStatementCommand,
  GetStatementResultCommand,
} from '@aws-sdk/client-redshift-data';
import { getStackOutputs } from '../../../utils';
import { rdsRedshiftZeroEtlRdsStackName } from './stack_rds';
import { rdsRedshiftProvisionedStackName } from './stack_redshift_provisioned';

// Usage:
//   AWS_REGION=eu-central-1 npx ts-node patterns/rds/rds-redshift-zero-etl/demo_server.ts
//
// Requires SSM port-forward tunnel before starting:
//   aws ssm start-session --target <bastion-id> --document-name AWS-StartPortForwardingSessionToRemoteHost \
//     --parameters host=<writer-endpoint>,portNumber=5432,localPortNumber=5432
//
// Redshift is accessed via the Data API (IAM auth) — no tunnel needed.
// The caller's IAM identity needs:
//   redshift-data:ExecuteStatement, DescribeStatement, GetStatementResult
//   redshift:GetClusterCredentials, secretsmanager:GetSecretValue

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// The Redshift database must be created manually after the integration becomes Active:
//   CREATE DATABASE demo FROM INTEGRATION '<integration-id>';
// Set REDSHIFT_DB to that database name (default: 'demo').
const REDSHIFT_DB = process.env.REDSHIFT_DB || 'demo';

let pool: Pool;
let redshiftClient: RedshiftDataClient;
let CLUSTER_IDENTIFIER: string;
let CLUSTER_SECRET_ARN: string;

(async () => {
  const [rdsOutputs, redshiftOutputs] = await Promise.all([
    getStackOutputs(rdsRedshiftZeroEtlRdsStackName),
    getStackOutputs(rdsRedshiftProvisionedStackName),
  ]);

  const secretArn = rdsOutputs['SecretArn'];
  const sm = new SecretsManagerClient({});
  const { SecretString } = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
  const { password } = JSON.parse(SecretString!);

  pool = new Pool({
    host: 'localhost',
    port: 5432,
    database: rdsOutputs['DatabaseName'],
    user: 'postgres',
    password,
    // RDS requires SSL. rejectUnauthorized=false allows the SSM tunnel where the
    // TLS certificate CN is the RDS endpoint, not localhost.
    ssl: { rejectUnauthorized: false },
  });

  CLUSTER_IDENTIFIER = redshiftOutputs['RedshiftClusterIdentifier'];
  CLUSTER_SECRET_ARN = redshiftOutputs['MasterUserSecretArn'];
  redshiftClient = new RedshiftDataClient({});

  app.listen(PORT, () => console.log(`Server on port ${PORT}`));
})();

// Create a table with a primary key and seed sample rows.
// Zero-ETL only replicates tables with a PRIMARY KEY — tables without one are silently skipped.
//
// POST /seed
app.post('/seed', async (_req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS quotes (
        id SERIAL PRIMARY KEY,
        text TEXT NOT NULL,
        author TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `);
    const samples = [
      ['The only way to do great work is to love what you do.', 'Steve Jobs'],
      ['In the middle of every difficulty lies opportunity.', 'Albert Einstein'],
      ['It does not matter how slowly you go as long as you do not stop.', 'Confucius'],
      ['Life is what happens when you are busy making other plans.', 'John Lennon'],
      ['The future belongs to those who believe in the beauty of their dreams.', 'Eleanor Roosevelt'],
    ];
    for (const [text, author] of samples) {
      await pool.query('INSERT INTO quotes (text, author) VALUES ($1, $2)', [text, author]);
    }
    res.json({ seeded: samples.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// Insert a single row into the quotes table.
//
// POST /write
// body: { text, author? }
app.post('/write', async (req, res) => {
  const { text, author } = req.body;
  if (!text) {
    res.status(400).json({ error: 'text is required' });
    return;
  }
  try {
    const result = await pool.query('INSERT INTO quotes (text, author) VALUES ($1, $2) RETURNING id', [
      text,
      author ?? null,
    ]);
    res.json({ id: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// Read all rows from the RDS source directly.
// Use this to confirm data was written before checking Redshift.
//
// GET /rds/rows
app.get('/rds/rows', async (_req, res) => {
  try {
    const result = await pool.query('SELECT * FROM quotes ORDER BY id');
    res.json({ rows: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// Execute SQL against Redshift via the Data API (async).
// Returns a statement ID to poll with GET /redshift/query/:id.
//
// POST /redshift/query
// body: { sql }
app.post('/redshift/query', async (req, res) => {
  const { sql } = req.body;
  if (!sql) {
    res.status(400).json({ error: 'sql is required' });
    return;
  }
  try {
    const result = await redshiftClient.send(
      new ExecuteStatementCommand({
        ClusterIdentifier: CLUSTER_IDENTIFIER,
        SecretArn: CLUSTER_SECRET_ARN,
        Database: REDSHIFT_DB,
        Sql: sql,
      }),
    );
    res.json({ id: result.Id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// Poll a Redshift query result.
//
// GET /redshift/query/:id
app.get('/redshift/query/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const status = await redshiftClient.send(new DescribeStatementCommand({ Id: id }));
    const state = status.Status;
    if (state !== 'FINISHED') {
      res.json({ state, error: status.Error });
      return;
    }
    const results = await redshiftClient.send(new GetStatementResultCommand({ Id: id }));
    const columns = results.ColumnMetadata?.map((c) => c.name ?? '') ?? [];
    const data = (results.Records ?? []).map((row) =>
      Object.fromEntries(
        row.map((field, i) => [
          columns[i],
          field.stringValue ?? field.longValue ?? field.doubleValue ?? field.booleanValue ?? null,
        ]),
      ),
    );
    res.json({ state, columns, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// List tables in the replicated Redshift database.
// Useful to confirm the Zero-ETL integration has materialised tables.
//
// GET /redshift/tables
app.get('/redshift/tables', async (_req, res) => {
  try {
    const exec = await redshiftClient.send(
      new ExecuteStatementCommand({
        ClusterIdentifier: CLUSTER_IDENTIFIER,
        SecretArn: CLUSTER_SECRET_ARN,
        Database: REDSHIFT_DB,
        Sql: "SELECT tablename, schemaname FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY schemaname, tablename",
      }),
    );
    // Poll until complete (tables query finishes in < 1s)
    let state = 'SUBMITTED';
    while (state !== 'FINISHED' && state !== 'FAILED' && state !== 'ABORTED') {
      await new Promise((r) => setTimeout(r, 500));
      const s = await redshiftClient.send(new DescribeStatementCommand({ Id: exec.Id }));
      state = s.Status ?? 'FAILED';
    }
    if (state !== 'FINISHED') {
      res.status(500).json({ error: `Query ended with state: ${state}` });
      return;
    }
    const results = await redshiftClient.send(new GetStatementResultCommand({ Id: exec.Id }));
    const tables = (results.Records ?? []).map((row) => ({
      schema: row[0].stringValue,
      table: row[1].stringValue,
    }));
    res.json({ tables });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

import express from 'express';
import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
} from '@aws-sdk/client-athena';
import { getStackOutputs } from '../../utils';
import { s3TablesStackName } from './stack';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

let TABLE_BUCKET_NAME: string;
let NAMESPACE: string;
let TABLE_NAME: string;
let WORKGROUP: string;
let CATALOG: string;
let athenaClient: AthenaClient;

(async () => {
  const outputs = await getStackOutputs(s3TablesStackName);
  console.log(`StackOutputs for ${s3TablesStackName}:`, outputs);
  TABLE_BUCKET_NAME = outputs['TableBucketName'];
  NAMESPACE = outputs['Namespace'];
  TABLE_NAME = outputs['TableName'];
  WORKGROUP = outputs['AthenaWorkGroupName'];
  // Athena accesses S3 Tables via a federated catalog — prefix is always s3tablescatalog/<bucket>.
  // Set in QueryExecutionContext.Catalog so SQL strings don't need catalog prefixes.
  CATALOG = `s3tablescatalog/${TABLE_BUCKET_NAME}`;
  athenaClient = new AthenaClient({});
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
})();

async function waitForQuery(id: string): Promise<{ columns: string[]; data: Record<string, string>[] }> {
  while (true) {
    const exec = await athenaClient.send(new GetQueryExecutionCommand({ QueryExecutionId: id }));
    const state = exec.QueryExecution?.Status?.State;
    if (state === 'SUCCEEDED') {
      const results = await athenaClient.send(new GetQueryResultsCommand({ QueryExecutionId: id }));
      const [header, ...rows] = results.ResultSet?.Rows ?? [];
      const columns = header?.Data?.map((d) => d.VarCharValue ?? '') ?? [];
      const data = rows.map((row) =>
        Object.fromEntries(row.Data?.map((d, i) => [columns[i], d.VarCharValue ?? '']) ?? []),
      );
      return { columns, data };
    }
    if (state === 'FAILED' || state === 'CANCELLED') {
      throw new Error(exec.QueryExecution?.Status?.StateChangeReason ?? state);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function startQuery(sql: string): Promise<string> {
  const result = await athenaClient.send(
    new StartQueryExecutionCommand({
      QueryString: sql,
      WorkGroup: WORKGROUP,
      QueryExecutionContext: { Catalog: CATALOG, Database: NAMESPACE },
    }),
  );
  return result.QueryExecutionId!;
}

// Insert 20 sample sales rows across two dates. Running /load twice inserts
// both date batches each time — rows accumulate, enabling time travel comparison.
// loadedAt is captured before the INSERT so it can be passed as asOf for time travel.
//
// POST /load
app.post('/load', async (req, res) => {
  const loadedAt = new Date().toISOString();
  const values = [
    // Batch 1 — 2024-01-15
    `('2024-01-15','laptop','electronics','eu-west-1',2,999.99,1999.98)`,
    `('2024-01-15','mouse','peripherals','eu-central-1',5,29.99,149.95)`,
    `('2024-01-15','keyboard','peripherals','us-east-1',3,79.99,239.97)`,
    `('2024-01-15','monitor','electronics','eu-west-1',1,349.99,349.99)`,
    `('2024-01-15','headphones','electronics','eu-central-1',4,149.99,599.96)`,
    `('2024-01-15','laptop','electronics','us-east-1',1,999.99,999.99)`,
    `('2024-01-15','mouse','peripherals','eu-west-1',10,29.99,299.90)`,
    `('2024-01-15','keyboard','peripherals','eu-central-1',2,79.99,159.98)`,
    `('2024-01-15','monitor','electronics','us-east-1',3,349.99,1049.97)`,
    `('2024-01-15','headphones','electronics','eu-west-1',2,149.99,299.98)`,
    // Batch 2 — 2024-02-15
    `('2024-02-15','laptop','electronics','eu-central-1',3,999.99,2999.97)`,
    `('2024-02-15','mouse','peripherals','us-east-1',8,29.99,239.92)`,
    `('2024-02-15','keyboard','peripherals','eu-west-1',4,79.99,319.96)`,
    `('2024-02-15','monitor','electronics','eu-central-1',2,349.99,699.98)`,
    `('2024-02-15','headphones','electronics','us-east-1',6,149.99,899.94)`,
    `('2024-02-15','laptop','electronics','eu-west-1',1,999.99,999.99)`,
    `('2024-02-15','mouse','peripherals','eu-central-1',12,29.99,359.88)`,
    `('2024-02-15','keyboard','peripherals','us-east-1',3,79.99,239.97)`,
    `('2024-02-15','monitor','electronics','eu-west-1',1,349.99,349.99)`,
    `('2024-02-15','headphones','electronics','eu-central-1',5,149.99,749.95)`,
  ];
  const sql = `INSERT INTO ${TABLE_NAME} VALUES ${values.join(',')}`;
  try {
    const id = await startQuery(sql);
    await waitForQuery(id);
    res.json({ inserted: 20, loadedAt });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

const PRESET_SQL: Record<string, (asOf?: string) => string> = {
  revenue_by_category: () =>
    `SELECT category, ROUND(SUM(total_amount), 2) as revenue FROM ${TABLE_NAME} GROUP BY category ORDER BY revenue DESC`,
  top_products: () =>
    `SELECT product, SUM(quantity) as units_sold, ROUND(SUM(total_amount), 2) as revenue FROM ${TABLE_NAME} GROUP BY product ORDER BY revenue DESC`,
  daily_sales: () =>
    `SELECT sale_date, COUNT(*) as transactions, ROUND(SUM(total_amount), 2) as revenue FROM ${TABLE_NAME} GROUP BY sale_date ORDER BY sale_date`,
  region_breakdown: () =>
    `SELECT region, category, ROUND(SUM(total_amount), 2) as revenue FROM ${TABLE_NAME} GROUP BY region, category ORDER BY region, revenue DESC`,
  time_travel: (asOf?: string) => {
    if (!asOf) throw new Error('asOf is required for time_travel preset');
    return `SELECT sale_date, COUNT(*) as cnt, ROUND(SUM(total_amount), 2) as revenue FROM ${TABLE_NAME} FOR SYSTEM_TIME AS OF TIMESTAMP '${asOf}' GROUP BY sale_date ORDER BY sale_date`;
  },
};

// Start an Athena query using a preset name or raw SQL.
// Returns immediately with queryExecutionId — poll GET /query/:id for results.
//
// POST /query
// body: { preset, asOf? } | { sql }
app.post('/query', async (req, res) => {
  const { preset, asOf, sql } = req.body;
  try {
    let queryString: string;
    if (sql) {
      queryString = sql;
    } else if (preset && PRESET_SQL[preset]) {
      queryString = PRESET_SQL[preset](asOf);
    } else {
      res.status(400).json({ error: 'provide preset or sql' });
      return;
    }
    const id = await startQuery(queryString);
    res.json({ queryExecutionId: id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// Poll Athena query status. Returns results when SUCCEEDED.
//
// GET /query/:id
app.get('/query/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const exec = await athenaClient.send(new GetQueryExecutionCommand({ QueryExecutionId: id }));
    const state = exec.QueryExecution?.Status?.State;
    if (state === 'SUCCEEDED') {
      const results = await athenaClient.send(new GetQueryResultsCommand({ QueryExecutionId: id }));
      const [header, ...rows] = results.ResultSet?.Rows ?? [];
      const columns = header?.Data?.map((d) => d.VarCharValue ?? '') ?? [];
      const data = rows.map((row) =>
        Object.fromEntries(row.Data?.map((d, i) => [columns[i], d.VarCharValue ?? '']) ?? []),
      );
      res.json({ state, columns, data });
    } else if (state === 'FAILED' || state === 'CANCELLED') {
      res.json({ state, reason: exec.QueryExecution?.Status?.StateChangeReason });
    } else {
      res.json({ state });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

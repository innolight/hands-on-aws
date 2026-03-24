import express from 'express';
import { DynamoDBClient, PutItemCommand, BatchWriteItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
} from '@aws-sdk/client-athena';
import { getStackOutputs } from '../../utils';
import { dynamodbToS3StackName } from './stack';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

let TABLE_NAME: string;
let WORKGROUP: string;
let RESULTS_BUCKET: string;
let ddbClient: DynamoDBClient;
let athenaClient: AthenaClient;

(async () => {
  const outputs = await getStackOutputs(dynamodbToS3StackName);
  console.log(`StackOutputs for ${dynamodbToS3StackName}:`, outputs);
  TABLE_NAME = outputs['TableName'];
  WORKGROUP = outputs['AthenaWorkGroupName'];
  RESULTS_BUCKET = outputs['AthenaResultsBucket'];
  ddbClient = new DynamoDBClient({});
  athenaClient = new AthenaClient({});
})();

// Write a single order item to DynamoDB.
// Zero-ETL will replicate this to S3 Tables within ~15 minutes.
//
// POST /items
// body: { orderId, itemId, product, quantity, price, status }
app.post('/items', async (req, res) => {
  const { orderId, itemId, product, quantity, price, status } = req.body;
  if (!orderId || !itemId || !product) {
    res.status(400).json({ error: 'orderId, itemId, and product are required' });
    return;
  }
  try {
    const item = marshall({
      pk: `ORDER#${orderId}`,
      sk: `ITEM#${itemId}`,
      product,
      quantity: quantity ?? 1,
      price: price ?? 0,
      status: status ?? 'pending',
      createdAt: new Date().toISOString(),
    });
    await ddbClient.send(new PutItemCommand({ TableName: TABLE_NAME, Item: item }));
    res.json({ written: { orderId, itemId, product } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// Seed 25 sample order items in a single BatchWriteItem call.
// Useful for generating enough data to make Athena queries interesting.
//
// POST /items/batch
app.post('/items/batch', async (req, res) => {
  const products = ['Widget A', 'Widget B', 'Gadget X', 'Gadget Y', 'Doohickey Z'];
  const statuses = ['pending', 'shipped', 'delivered'];

  const requests = Array.from({ length: 25 }, (_, i) => ({
    PutRequest: {
      Item: marshall({
        pk: `ORDER#${String(i + 1).padStart(3, '0')}`,
        sk: `ITEM#${String(i + 1).padStart(3, '0')}`,
        product: products[i % products.length],
        quantity: (i % 5) + 1,
        price: parseFloat(((i + 1) * 9.99).toFixed(2)),
        status: statuses[i % statuses.length],
        createdAt: new Date().toISOString(),
      }),
    },
  }));

  try {
    await ddbClient.send(
      new BatchWriteItemCommand({
        RequestItems: { [TABLE_NAME]: requests },
      }),
    );
    res.json({ seeded: 25 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// Start an Athena query against the replicated Iceberg table.
// The database and table names are set by Glue Zero-ETL — discover them
// in the AWS Glue console under Databases after the integration completes.
//
// POST /query
// body: { sql } — e.g. "SELECT * FROM \"zero-etl-demo\".\"zero-etl-demo\" LIMIT 10"
app.post('/query', async (req, res) => {
  const { sql } = req.body;
  if (!sql) {
    res.status(400).json({ error: 'sql is required' });
    return;
  }
  try {
    const result = await athenaClient.send(
      new StartQueryExecutionCommand({
        QueryString: sql,
        WorkGroup: WORKGROUP,
        ResultConfiguration: { OutputLocation: `s3://${RESULTS_BUCKET}/results/` },
      }),
    );
    res.json({ queryExecutionId: result.QueryExecutionId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// Poll Athena query status and return results when complete.
//
// GET /query/:id
app.get('/query/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const exec = await athenaClient.send(new GetQueryExecutionCommand({ QueryExecutionId: id }));
    const state = exec.QueryExecution?.Status?.State;
    if (state !== 'SUCCEEDED') {
      res.json({ state, reason: exec.QueryExecution?.Status?.StateChangeReason });
      return;
    }
    const results = await athenaClient.send(new GetQueryResultsCommand({ QueryExecutionId: id }));
    const [header, ...rows] = results.ResultSet?.Rows ?? [];
    const columns = header?.Data?.map((d) => d.VarCharValue ?? '') ?? [];
    const data = rows.map((row) => Object.fromEntries(row.Data?.map((d, i) => [columns[i], d.VarCharValue]) ?? []));
    res.json({ state, columns, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

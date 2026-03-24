import express from 'express';
import {
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
  GetItemCommand,
  DeleteItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { getStackOutputs } from '../../utils/stackoutput';
import { dynamodbLambdaStackName } from './stack';

const app = express();
app.use(express.json());

const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'eu-central-1' });

async function getTableName() {
  const outputs = await getStackOutputs(dynamodbLambdaStackName);
  return outputs.TableName;
}

// Create a new order (Triggers INSERT event in Stream)
app.post('/orders', async (req, res) => {
  const { orderId, amount } = req.body;
  const tableName = await getTableName();

  const item = {
    orderId: orderId || `order-${Date.now()}`,
    amount: amount || 100,
    status: 'PENDING',
    createdAt: new Date().toISOString(),
  };

  await client.send(
    new PutItemCommand({
      TableName: tableName,
      Item: marshall(item),
    }),
  );

  res.json({ message: 'Order created!', order: item });
});

// Pay an order (Triggers MODIFY event in Stream)
app.patch('/orders/:id/pay', async (req, res) => {
  const { id } = req.params;
  const tableName = await getTableName();

  await client.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: marshall({ orderId: id }),
      UpdateExpression: 'SET #s = :status',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: marshall({ ':status': 'PAID' }),
    }),
  );

  res.json({ message: `Order ${id} paid!` });
});

// Delete an order (Triggers REMOVE event in Stream)
app.delete('/orders/:id', async (req, res) => {
  const { id } = req.params;
  const tableName = await getTableName();

  await client.send(
    new DeleteItemCommand({
      TableName: tableName,
      Key: marshall({ orderId: id }),
    }),
  );

  res.json({ message: `Order ${id} deleted!` });
});

// Trigger a failure (For demoing DLQ/Bisect)
app.post('/orders/fail', async (req, res) => {
  const tableName = await getTableName();
  const orderId = `FAIL-${Date.now()}`;

  await client.send(
    new PutItemCommand({
      TableName: tableName,
      Item: marshall({
        orderId,
        status: 'ERROR_PRONE',
        createdAt: new Date().toISOString(),
      }),
    }),
  );

  res.json({ message: 'Failure-triggering order created!', orderId });
});

const port = 3000;
app.listen(port, () => {
  console.log(`Demo server running at http://localhost:${port}`);
  console.log('1. POST   /orders          - Create order (INSERT)');
  console.log('2. PATCH  /orders/:id/pay  - Pay order (MODIFY)');
  console.log('3. DELETE /orders/:id      - Delete order (REMOVE)');
  console.log('4. POST   /orders/fail     - Trigger failure');
});

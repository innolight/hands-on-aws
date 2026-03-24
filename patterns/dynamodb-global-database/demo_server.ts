import express from 'express';
import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  QueryCommand,
  DeleteItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { getStackOutputs } from '../../utils';
import { dynamodbGlobalDatabaseStackName } from './stack';

// Global Tables v2 is multi-active: both regions accept reads and writes with
// equal standing. There is no primary region — "eu" and "us" are just labels.
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

let TABLE_NAME: string;
let regionEU: string;
let regionUS: string;
let euClient: DynamoDBClient;
let usClient: DynamoDBClient;
let clients: Record<string, DynamoDBClient>;

(async () => {
  const outputs = await getStackOutputs(dynamodbGlobalDatabaseStackName);
  console.log(`StackOutputs for ${dynamodbGlobalDatabaseStackName}:`, outputs);
  TABLE_NAME = outputs['TableName'];
  regionEU = outputs['RegionEU'];
  regionUS = outputs['RegionUS'];
  euClient = new DynamoDBClient({ region: regionEU });
  usClient = new DynamoDBClient({ region: regionUS });
  clients = { [regionEU]: euClient, [regionUS]: usClient };
})();

// Write a Post to the specified region. Demonstrates replication lag when
// the item is immediately read back from the other region.
//
// POST /users/:userId/posts?region=<region>
// POST /users/:userId/posts?multiRegionWrite=true
// body: { postId, title, body }
app.post('/users/:userId/posts', async (req, res) => {
  const { userId } = req.params;
  const { postId, title, body } = req.body;
  const { region, multiRegionWrite } = req.query;

  if (!postId || !title || !body) {
    res.status(400).json({ error: 'postId, title, and body are required' });
    return;
  }

  const buildItem = (originRegion: string) =>
    marshall({
      pk: `USER#${userId}`,
      sk: `POST#${postId}`,
      entityType: 'Post',
      title,
      body,
      origin: originRegion,
      updatedAt: new Date().toISOString(),
    });

  try {
    if (multiRegionWrite === 'true') {
      // Write concurrently to both regions with different origin values.
      // Last-writer-wins (by DynamoDB LSN) determines the final value — call
      // GET repeatedly after this to observe both replicas converge.
      const [euResult, usResult] = await Promise.allSettled([
        euClient.send(new PutItemCommand({ TableName: TABLE_NAME, Item: buildItem(regionEU) })),
        usClient.send(new PutItemCommand({ TableName: TABLE_NAME, Item: buildItem(regionUS) })),
      ]);
      res.json({ [regionEU]: euResult.status, [regionUS]: usResult.status });
      return;
    }

    const enabledRegions = [regionEU, regionUS];
    if (!enabledRegions.includes(region as string)) {
      res.status(400).json({ error: `region must be one of: ${enabledRegions.join(', ')}` });
      return;
    }

    const client = clients[region as string];
    const item = buildItem(region as string);
    await client.send(new PutItemCommand({ TableName: TABLE_NAME, Item: item }));
    res.json({ written: unmarshall(item), region });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// Read a single Post from ALL regions concurrently. Shows replication lag:
// immediately after a write the other region may return null; retry after ~1s.
//
// GET /users/:userId/posts/:postId
app.get('/users/:userId/posts/:postId', async (req, res) => {
  const { userId, postId } = req.params;
  const key = marshall({ pk: `USER#${userId}`, sk: `POST#${postId}` });
  try {
    const results = await Promise.all(
      Object.entries(clients).map(async ([region, client]) => {
        const { Item } = await client.send(new GetItemCommand({ TableName: TABLE_NAME, Key: key }));
        return [region, Item ? unmarshall(Item) : null] as const;
      }),
    );
    res.json(Object.fromEntries(results));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// List all Posts for a user from ALL regions concurrently.
// ?consistent=true adds ConsistentRead — only guarantees freshness within
// the queried region's own replica, not across regions.
//
// GET /users/:userId/posts[?consistent=true]
app.get('/users/:userId/posts', async (req, res) => {
  const { userId } = req.params;
  const consistentRead = req.query.consistent === 'true';
  try {
    const results = await Promise.all(
      Object.entries(clients).map(async ([region, client]) => {
        const { Items = [] } = await client.send(
          new QueryCommand({
            TableName: TABLE_NAME,
            KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
            ExpressionAttributeValues: marshall({ ':pk': `USER#${userId}`, ':prefix': 'POST#' }),
            // ConsistentRead only guarantees freshness within this region's replica.
            // A cross-region comparison with consistent=true can still show divergent
            // values — this is expected and demonstrates eventual consistency.
            ConsistentRead: consistentRead,
          }),
        );
        return [region, Items.map((i) => unmarshall(i))] as const;
      }),
    );
    const response: Record<string, unknown> = Object.fromEntries(results);
    if (consistentRead) {
      response._note = 'ConsistentRead is per-region only; cross-region divergence is still possible';
    }
    res.json(response);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// Delete a Post from the specified region. The delete (tombstone) replicates
// to all other replicas — demonstrates that deletes propagate like writes.
//
// DELETE /users/:userId/posts/:postId?region=<region>
app.delete('/users/:userId/posts/:postId', async (req, res) => {
  const { userId, postId } = req.params;
  const { region } = req.query;
  const enabledRegions = [regionEU, regionUS];
  if (!enabledRegions.includes(region as string)) {
    res.status(400).json({ error: `region must be one of: ${enabledRegions.join(', ')}` });
    return;
  }
  try {
    const client = clients[region as string];
    await client.send(
      new DeleteItemCommand({
        TableName: TABLE_NAME,
        Key: marshall({ pk: `USER#${userId}`, sk: `POST#${postId}` }),
      }),
    );
    res.json({ deleted: true, region });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// Query the byOrigin GSI on a specific region's replica.
// Demonstrates that GSIs replicate automatically — no per-replica config needed.
//
// GET /posts?region=<region>
app.get('/posts', async (req, res) => {
  const { region } = req.query;
  const enabledRegions = [regionEU, regionUS];
  if (!enabledRegions.includes(region as string)) {
    res.status(400).json({ error: `region must be one of: ${enabledRegions.join(', ')}` });
    return;
  }
  try {
    const client = clients[region as string];
    const { Items = [] } = await client.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'byOrigin',
        KeyConditionExpression: 'origin = :origin',
        ExpressionAttributeValues: marshall({ ':origin': region }),
      }),
    );
    res.json({ region, items: Items.map((i) => unmarshall(i)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

import express from 'express';
import {
  S3VectorsClient,
  PutVectorsCommand,
  QueryVectorsCommand,
  GetVectorsCommand,
  ListVectorsCommand,
  DeleteVectorsCommand,
} from '@aws-sdk/client-s3vectors';
import { getStackOutputs } from '../../utils';
import { s3VectorsStackName } from './stack';
import { CSV_PATH, parseCSV } from './csv_parser';

// Similarity search: load pre-computed food review embeddings → PutVectors →
// QueryVectors to find nearest neighbours by cosine distance
const app = express();
const PORT = process.env.PORT || 3000;
// PutVectors accepts at most 50 vectors per request
const BATCH_SIZE = 50;

app.use(express.json());

let client: S3VectorsClient;
let VECTOR_BUCKET_NAME: string;
let INDEX_NAME: string;

(async () => {
  const outputs = await getStackOutputs(s3VectorsStackName);
  console.log(`StackOutputs for ${s3VectorsStackName}:`, outputs);
  VECTOR_BUCKET_NAME = outputs['VectorBucketName'];
  INDEX_NAME = outputs['IndexName'];
  client = new S3VectorsClient({ region: process.env.AWS_REGION || 'eu-central-1' });

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
})();

// POST /load — parse CSV and upload all 1,000 vectors in batches of 50.
// Each vector key is the row index (string). Idempotent: re-running
// overwrites existing vectors with the same key.
app.post('/load', async (_req, res) => {
  try {
    console.log('Parsing CSV...');
    const rows = await parseCSV(CSV_PATH);
    console.log(`Parsed ${rows.length} rows. Uploading in batches of ${BATCH_SIZE}...`);

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      await client.send(
        new PutVectorsCommand({
          vectorBucketName: VECTOR_BUCKET_NAME,
          indexName: INDEX_NAME,
          vectors: batch.map((row) => ({
            key: String(row.rowIndex),
            data: { float32: row.embedding },
            // All metadata keys are stored together. Score, Summary, and ProductId
            // are filterable (indexed). Text is declared non-filterable in the index
            // schema — stored for retrieval only.
            metadata: {
              Score: row.Score,
              Summary: row.Summary,
              ProductId: row.ProductId,
              Text: row.Text,
            },
          })),
        }),
      );
      console.log(`Uploaded batch ${i / BATCH_SIZE + 1} / ${Math.ceil(rows.length / BATCH_SIZE)}`);
    }

    res.json({ loaded: rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// GET /search/:rowIndex — find similar reviews to the review at :rowIndex.
// Fetches the stored embedding via GetVectors then queries for nearest neighbours.
// This is the core similarity search flow: no embedding API needed.
//
// ?topK=5       — number of results (default 5)
// ?minScore=5   — filter to only reviews with Score >= minScore
app.get('/search/:rowIndex', async (req, res) => {
  const rowIndex = req.params.rowIndex;
  const topK = parseInt((req.query.topK as string) || '5', 10);
  const minScore = req.query.minScore ? parseInt(req.query.minScore as string, 10) : undefined;

  try {
    // Retrieve the stored vector for this row to use as the query vector
    const getResult = await client.send(
      new GetVectorsCommand({
        vectorBucketName: VECTOR_BUCKET_NAME,
        indexName: INDEX_NAME,
        keys: [rowIndex],
        returnData: true,
        returnMetadata: true,
      }),
    );

    const vectors = getResult.vectors ?? [];
    if (vectors.length === 0) {
      res.status(404).json({ error: `Row ${rowIndex} not found. Run POST /load first.` });
      return;
    }

    const queryVector = vectors[0].data?.float32;
    if (!queryVector) {
      res.status(500).json({ error: 'Vector data not available' });
      return;
    }

    // QueryVectors requires s3vectors:GetVectors in addition to s3vectors:QueryVectors
    // when returnMetadata is true or a filter is specified.
    const queryResult = await client.send(
      new QueryVectorsCommand({
        vectorBucketName: VECTOR_BUCKET_NAME,
        indexName: INDEX_NAME,
        queryVector: { float32: queryVector },
        topK: topK + 1, // +1 to account for the query row itself which we exclude
        returnMetadata: true,
        returnDistance: true,
        // S3 Vectors filter DSL uses MongoDB-style operators.
        filter: minScore !== undefined ? { Score: { $gte: minScore } } : undefined,
      }),
    );

    res.json({
      queryRow: rowIndex,
      queryMetadata: vectors[0].metadata,
      results: (queryResult.vectors ?? [])
        .filter((v) => v.key !== rowIndex)
        .map((v) => ({
          key: v.key,
          distance: v.distance,
          metadata: v.metadata,
        })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /vectors — remove all vectors from the index so the stack can be destroyed.
// Lists all keys via paginated ListVectors then deletes in batches of 50.
app.delete('/vectors', async (_req, res) => {
  try {
    const keys: string[] = [];
    let nextToken: string | undefined;

    // Collect all keys via paginated listing (keys only — no returnData/returnMetadata)
    do {
      const listResult = await client.send(
        new ListVectorsCommand({
          vectorBucketName: VECTOR_BUCKET_NAME,
          indexName: INDEX_NAME,
          maxResults: 500,
          nextToken,
        }),
      );
      for (const v of listResult.vectors ?? []) keys.push(v.key!);
      nextToken = listResult.nextToken;
    } while (nextToken);

    // Delete in batches of 50 (same limit as PutVectors)
    for (let i = 0; i < keys.length; i += BATCH_SIZE) {
      await client.send(
        new DeleteVectorsCommand({
          vectorBucketName: VECTOR_BUCKET_NAME,
          indexName: INDEX_NAME,
          keys: keys.slice(i, i + BATCH_SIZE),
        }),
      );
    }

    res.json({ deleted: keys.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// POST /query — query with a vector from an existing row index.
// Useful for programmatic access with custom topK/filter combinations.
//
// Body: { "rowIndex": "42", "topK": 5, "minScore": 4 }
app.post('/query', async (req, res) => {
  const { rowIndex, topK = 5, minScore } = req.body;

  if (rowIndex === undefined) {
    res.status(400).json({ error: 'rowIndex is required' });
    return;
  }

  try {
    const getResult = await client.send(
      new GetVectorsCommand({
        vectorBucketName: VECTOR_BUCKET_NAME,
        indexName: INDEX_NAME,
        keys: [String(rowIndex)],
        returnData: true,
      }),
    );

    const vectors = getResult.vectors ?? [];
    if (vectors.length === 0) {
      res.status(404).json({ error: `Row ${rowIndex} not found. Run POST /load first.` });
      return;
    }

    const queryVector = vectors[0].data?.float32;
    if (!queryVector) {
      res.status(500).json({ error: 'Vector data not available' });
      return;
    }

    const queryResult = await client.send(
      new QueryVectorsCommand({
        vectorBucketName: VECTOR_BUCKET_NAME,
        indexName: INDEX_NAME,
        queryVector: { float32: queryVector },
        topK,
        returnMetadata: true,
        returnDistance: true,
        filter: minScore !== undefined ? { Score: { $gte: minScore } } : undefined,
      }),
    );

    res.json({
      results: (queryResult.vectors ?? [])
        .filter((v) => v.key !== String(rowIndex))
        .map((v) => ({
          key: v.key,
          distance: v.distance,
          metadata: v.metadata,
        })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

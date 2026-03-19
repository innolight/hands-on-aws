import express from 'express';
import {Client, errors} from '@opensearch-project/opensearch';

export const INDEX_NAME = 'products';

export interface Product {
  id: string;
  name: string;
  description: string;
  category: string;
  price: number;
  inStock: boolean;
}

// Retry wrapper for 429 (thread pool rejection). Provisioned OpenSearch returns 429 when
// the bulk thread pool is full — this indicates the cluster needs time to catch up.
// Exponential backoff + jitter avoids synchronized retries from multiple clients.
export async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 4): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const is429 = err instanceof errors.ResponseError && err.statusCode === 429;
      if (!is429 || attempt === maxAttempts) throw err;
      const backoff = Math.min(100 * Math.pow(2, attempt - 1), 5000);
      const jitter = Math.random() * 200;
      console.warn(`Thread pool rejection (429), attempt ${attempt}/${maxAttempts}, retrying in ${Math.round(backoff + jitter)}ms`);
      await new Promise(r => setTimeout(r, backoff + jitter));
    }
  }
  throw new Error('unreachable');
}

export function createApp(client: Client): express.Application {
  const app = express();
  app.use(express.json());

  // PUT /index — create the products index with explicit field mappings.
  // Run this once before indexing documents.
  app.put('/index', async (_req, res) => {
    try {
      await withRetry(() => client.indices.create({
        index: INDEX_NAME,
        body: {
          settings: {
            // 1 replica: each primary shard has one copy on the other data node.
            // Matches the 2-node zone-aware setup — one primary in AZ-a, one replica in AZ-b.
            // AOSS manages replicas automatically and rejects this setting if specified.
            number_of_replicas: 1,
            // refresh_interval defaults to 1s — newly indexed documents become searchable
            // within ~1 second. AOSS manages this automatically (~10s delay).
          },
          mappings: {
            // dynamic: 'strict' rejects documents with unmapped fields.
            // Tradeoff vs dynamic: true — prevents accidental field explosions (mapping
            // bomb) but requires schema changes to be deployed explicitly.
            dynamic: 'strict',
            properties: {
              // text: analyzed for full-text search (tokenized, stemmed, lowercased).
              id:          {type: 'keyword'},
              name:        {type: 'text', fields: {keyword: {type: 'keyword'}}},
              description: {type: 'text'},
              // keyword: exact match and aggregations (not analyzed).
              category:    {type: 'keyword'},
              price:       {type: 'float'},
              inStock:     {type: 'boolean'},
            },
          },
        },
      }));
      res.json({created: INDEX_NAME});
    } catch (err) {
      handleError(res, err);
    }
  });

  // DELETE /index — delete the index and all documents.
  app.delete('/index', async (_req, res) => {
    try {
      await withRetry(() => client.indices.delete({index: INDEX_NAME}));
      res.json({deleted: INDEX_NAME});
    } catch (err) {
      handleError(res, err);
    }
  });

  // POST /products — index a single product.
  // refresh_interval is 1s by default — newly indexed documents become searchable within ~1 second.
  app.post('/products', async (req, res) => {
    const product: Product = req.body;
    try {
      const result = await withRetry(() => client.index({index: INDEX_NAME, id: product.id, body: product}));
      res.status(201).json({id: result.body._id});
    } catch (err) {
      handleError(res, err);
    }
  });

  // POST /products/_bulk — bulk index an array of products.
  // client.bulk accepts alternating action/document pairs built with flatMap,
  // which lets us set _id from product.id while still including id in the document body.
  app.post('/products/_bulk', async (req, res) => {
    const products: Product[] = req.body;
    if (!Array.isArray(products) || products.length === 0) {
      res.status(400).json({error: 'body must be a non-empty array of products'});
      return;
    }
    try {
      const body = products.flatMap(product => [
        {index: {_index: INDEX_NAME, _id: product.id}},
        product,
      ]);
      const result = await withRetry(() => client.bulk({body}));
      const failed = result.body.errors
        ? result.body.items.filter((item: Record<string, {error?: unknown}>) => item.index?.error).length
        : 0;
      res.json({indexed: products.length - failed, failed});
    } catch (err) {
      handleError(res, err);
    }
  });

  // GET /products/:id — retrieve a document by ID.
  app.get('/products/:id', async (req, res) => {
    try {
      const result = await withRetry(() => client.get({index: INDEX_NAME, id: req.params.id}));
      res.json({id: result.body._id, ...result.body._source as object});
    } catch (err) {
      handleError(res, err);
    }
  });

  // DELETE /products/:id — delete a document by ID.
  app.delete('/products/:id', async (req, res) => {
    try {
      await withRetry(() => client.delete({index: INDEX_NAME, id: req.params.id}));
      res.json({deleted: req.params.id});
    } catch (err) {
      handleError(res, err);
    }
  });

  // GET /search?q=&limit=&search_after= — full-text search with pagination.
  // Searches name and description fields; uses search_after for cursor-based pagination.
  // Alternative: Scroll API — available on provisioned (unlike AOSS), but search_after
  // is preferred for real-time use cases (Scroll holds point-in-time state on the cluster).
  app.get('/search', async (req, res) => {
    const {q = '', limit = '10', search_after} = req.query as Record<string, string>;
    try {
      const body: Record<string, unknown> = {
        size: Math.min(Number(limit), 100),
        query: q
          ? {
              multi_match: {
                query: q,
                fields: ['name^2', 'description'],
                // name^2: boost name matches over description matches.
              },
            }
          : {match_all: {}},
        // Sort by score + _id tiebreaker. _id is required for stable search_after pagination.
        sort: [{_score: 'desc'}, {_id: 'asc'}],
        // Return only these fields to reduce response size.
        _source: ['id', 'name', 'category', 'price', 'inStock'],
      };
      if (search_after) {
        body.search_after = JSON.parse(search_after);
      }
      const result = await withRetry(() => client.search({index: INDEX_NAME, body}));
      const hits: Array<Record<string, unknown>> = result.body.hits.hits;
      const total = result.body.hits.total;
      res.json({
        total: typeof total === 'object' ? total.value : total,
        hits: hits.map(h => ({id: h._id, score: h._score, ...(h._source as object)})),
        // Pass search_after value as a query param in the next request to get the next page.
        next_search_after: hits.length > 0 ? hits[hits.length - 1].sort : null,
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  // GET /search/advanced?category=&minPrice=&maxPrice=&q=&inStock=
  // Demonstrates bool query: must (scored, affects relevance) vs filter (cached, no scoring).
  // filter clauses are cached by OpenSearch and do not affect _score — use them for
  // structured constraints (price range, category, boolean flags).
  app.get('/search/advanced', async (req, res) => {
    const {category, minPrice, maxPrice, q, inStock} = req.query as Record<string, string>;
    const filter: Record<string, unknown>[] = [];
    if (category) filter.push({term: {category}});
    if (minPrice || maxPrice) {
      const range: Record<string, number> = {};
      if (minPrice) range.gte = Number(minPrice);
      if (maxPrice) range.lte = Number(maxPrice);
      filter.push({range: {price: range}});
    }
    if (inStock !== undefined) filter.push({term: {inStock: inStock === 'true'}});

    try {
      const result = await withRetry(() =>
        client.search({
          index: INDEX_NAME,
          body: {
            query: {
              bool: {
                // must: scored — contributes to _score, matched documents rank higher.
                must: q ? [{multi_match: {query: q, fields: ['name^2', 'description']}}] : [{match_all: {}}],
                // filter: not scored — results are cached, faster for repeated queries.
                filter,
              },
            },
            // Aggregations run on the full filter result, not just the current page.
            aggs: {
              by_category: {terms: {field: 'category', size: 20}},
              price_stats: {stats: {field: 'price'}},
              in_stock_count: {filter: {term: {inStock: true}}},
            },
            size: 20,
            sort: [{_score: 'desc'}, {_id: 'asc'}],
          },
        })
      );
      const hits: Array<Record<string, unknown>> = result.body.hits.hits;
      const total = result.body.hits.total;
      res.json({
        total: typeof total === 'object' ? total.value : total,
        hits: hits.map(h => ({id: h._id, score: h._score, ...(h._source as object)})),
        aggregations: result.body.aggregations,
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  return app;
}

function handleError(res: express.Response, err: unknown) {
  console.error(err);
  if (err instanceof errors.ResponseError) {
    const status = err.statusCode ?? 500;
    if (status === 404) {
      res.status(404).json({error: 'not found', detail: err.message});
    } else if (status === 409) {
      res.status(409).json({error: 'conflict', detail: err.message});
    } else if (status === 429) {
      res.status(429).json({error: 'thread pool rejection — retry after backoff', detail: err.message});
    } else {
      res.status(status).json({error: 'opensearch error', detail: err.message});
    }
  } else if (err instanceof errors.ConnectionError || err instanceof errors.TimeoutError) {
    res.status(503).json({error: 'connection error — is the SSM tunnel running?', detail: String(err)});
  } else {
    res.status(500).json({error: String(err)});
  }
}

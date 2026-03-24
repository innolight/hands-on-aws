import request from 'supertest';
import { Client, errors } from '@opensearch-project/opensearch';
import { createApp, withRetry, INDEX_NAME, Product } from './app';

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation();
  jest.spyOn(console, 'warn').mockImplementation();
});
afterEach(() => jest.restoreAllMocks());

// Build a minimal ResponseError with a given HTTP status code.
function makeResponseError(statusCode: number): errors.ResponseError {
  return new errors.ResponseError({ statusCode, body: {}, headers: {}, warnings: null, meta: {} as never });
}

// Build a minimal mock Client. Only the methods exercised by the routes are needed.
function makeClient(
  overrides: Partial<{
    indicesCreate: jest.Mock;
    indicesDelete: jest.Mock;
    index: jest.Mock;
    bulk: jest.Mock;
    get: jest.Mock;
    delete: jest.Mock;
    search: jest.Mock;
  }> = {},
): Client {
  return {
    indices: {
      create: overrides.indicesCreate ?? jest.fn(),
      delete: overrides.indicesDelete ?? jest.fn(),
    },
    index: overrides.index ?? jest.fn(),
    bulk: overrides.bulk ?? jest.fn(),
    get: overrides.get ?? jest.fn(),
    delete: overrides.delete ?? jest.fn(),
    search: overrides.search ?? jest.fn(),
  } as unknown as Client;
}

// Wrap the body in the shape the OpenSearch client returns.
function okResponse(body: Record<string, unknown>) {
  return { body };
}

const PRODUCT: Product = {
  id: 'prod-1',
  name: 'Wireless Headphones',
  description: 'Noise-cancelling over-ear headphones',
  category: 'electronics',
  price: 149.99,
  inStock: true,
};

describe('PUT /index', () => {
  test('creates index and returns {created}', async () => {
    const indicesCreate = jest.fn().mockResolvedValue(okResponse({ acknowledged: true }));
    const app = createApp(makeClient({ indicesCreate }));

    const res = await request(app).put('/index');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ created: INDEX_NAME });
    expect(indicesCreate).toHaveBeenCalledWith(expect.objectContaining({ index: INDEX_NAME }));
  });

  test('passes number_of_replicas: 1 in settings', async () => {
    const indicesCreate = jest.fn().mockResolvedValue(okResponse({}));
    const app = createApp(makeClient({ indicesCreate }));

    await request(app).put('/index');

    const { body } = indicesCreate.mock.calls[0][0];
    expect(body.settings.number_of_replicas).toBe(1);
  });

  test('passes dynamic:strict mappings with all product fields', async () => {
    const indicesCreate = jest.fn().mockResolvedValue(okResponse({}));
    const app = createApp(makeClient({ indicesCreate }));

    await request(app).put('/index');

    const { body } = indicesCreate.mock.calls[0][0];
    expect(body.mappings.dynamic).toBe('strict');
    expect(Object.keys(body.mappings.properties)).toEqual(
      expect.arrayContaining(['id', 'name', 'description', 'category', 'price', 'inStock']),
    );
  });

  test('returns 409 when index already exists', async () => {
    const indicesCreate = jest.fn().mockRejectedValue(makeResponseError(409));
    const app = createApp(makeClient({ indicesCreate }));

    const res = await request(app).put('/index');

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('conflict');
  });
});

describe('DELETE /index', () => {
  test('deletes index and returns {deleted}', async () => {
    const indicesDelete = jest.fn().mockResolvedValue(okResponse({ acknowledged: true }));
    const app = createApp(makeClient({ indicesDelete }));

    const res = await request(app).delete('/index');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: INDEX_NAME });
    expect(indicesDelete).toHaveBeenCalledWith({ index: INDEX_NAME });
  });

  test('returns 404 when index does not exist', async () => {
    const indicesDelete = jest.fn().mockRejectedValue(makeResponseError(404));
    const app = createApp(makeClient({ indicesDelete }));

    const res = await request(app).delete('/index');

    expect(res.status).toBe(404);
  });
});

describe('POST /products', () => {
  test('indexes product and returns generated id', async () => {
    const index = jest.fn().mockResolvedValue(okResponse({ _id: 'prod-1' }));
    const app = createApp(makeClient({ index }));

    const res = await request(app).post('/products').send(PRODUCT);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 'prod-1' });
    expect(index).toHaveBeenCalledWith(expect.objectContaining({ index: INDEX_NAME, id: PRODUCT.id, body: PRODUCT }));
  });

  test('returns 503 on connection error', async () => {
    const index = jest.fn().mockRejectedValue(new errors.ConnectionError('connect ECONNREFUSED'));
    const app = createApp(makeClient({ index }));

    const res = await request(app).post('/products').send(PRODUCT);

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/SSM tunnel/);
  });
});

describe('POST /products/_bulk', () => {
  test('returns 400 for empty array', async () => {
    const app = createApp(makeClient());

    const res = await request(app).post('/products/_bulk').send([]);

    expect(res.status).toBe(400);
  });

  test('indexes all products and reports zero failures', async () => {
    const bulk = jest.fn().mockResolvedValue(okResponse({ errors: false, items: [] }));
    const app = createApp(makeClient({ bulk }));

    const products = [PRODUCT, { ...PRODUCT, id: 'prod-2', name: 'Keyboard' }];
    const res = await request(app).post('/products/_bulk').send(products);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ indexed: 2, failed: 0 });
    // Bulk body alternates action + document pairs.
    const { body } = bulk.mock.calls[0][0];
    expect(body[0]).toEqual({ index: { _index: INDEX_NAME, _id: 'prod-1' } });
    expect(body[1]).toEqual(PRODUCT);
    expect(body[2]).toEqual({ index: { _index: INDEX_NAME, _id: 'prod-2' } });
  });

  test('reports partial failures from bulk response', async () => {
    const bulk = jest.fn().mockResolvedValue(
      okResponse({
        errors: true,
        items: [
          { index: { _id: 'prod-1', status: 200 } },
          { index: { _id: 'prod-2', status: 400, error: { type: 'mapper_parsing_exception' } } },
        ],
      }),
    );
    const app = createApp(makeClient({ bulk }));

    const res = await request(app)
      .post('/products/_bulk')
      .send([PRODUCT, { ...PRODUCT, id: 'prod-2' }]);

    expect(res.body).toEqual({ indexed: 1, failed: 1 });
  });
});

describe('GET /products/:id', () => {
  test('returns product by id', async () => {
    const get = jest.fn().mockResolvedValue(
      okResponse({
        _id: 'prod-1',
        _source: { name: 'Wireless Headphones', category: 'electronics' },
      }),
    );
    const app = createApp(makeClient({ get }));

    const res = await request(app).get('/products/prod-1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'prod-1', name: 'Wireless Headphones', category: 'electronics' });
    expect(get).toHaveBeenCalledWith({ index: INDEX_NAME, id: 'prod-1' });
  });

  test('returns 404 when document not found', async () => {
    const get = jest.fn().mockRejectedValue(makeResponseError(404));
    const app = createApp(makeClient({ get }));

    const res = await request(app).get('/products/missing');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not found');
  });
});

describe('DELETE /products/:id', () => {
  test('deletes document and returns {deleted: id}', async () => {
    const del = jest.fn().mockResolvedValue(okResponse({ result: 'deleted' }));
    const app = createApp(makeClient({ delete: del }));

    const res = await request(app).delete('/products/prod-1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 'prod-1' });
    expect(del).toHaveBeenCalledWith({ index: INDEX_NAME, id: 'prod-1' });
  });
});

describe('GET /search', () => {
  function makeSearchResponse(hits: Array<{ _id: string; _source: object; sort?: unknown[] }>, total = hits.length) {
    return okResponse({
      hits: {
        total: { value: total },
        hits: hits.map((h) => ({ _id: h._id, _score: 1.0, _source: h._source, sort: h.sort ?? [1.0, h._id] })),
      },
    });
  }

  test('issues match_all query when q is absent', async () => {
    const search = jest.fn().mockResolvedValue(makeSearchResponse([]));
    const app = createApp(makeClient({ search }));

    await request(app).get('/search');

    const { body } = search.mock.calls[0][0];
    expect(body.query).toEqual({ match_all: {} });
  });

  test('issues multi_match query when q is provided', async () => {
    const search = jest.fn().mockResolvedValue(makeSearchResponse([]));
    const app = createApp(makeClient({ search }));

    await request(app).get('/search?q=headphones');

    const { body } = search.mock.calls[0][0];
    expect(body.query.multi_match.query).toBe('headphones');
    expect(body.query.multi_match.fields).toEqual(['name^2', 'description']);
  });

  test('caps limit at 100', async () => {
    const search = jest.fn().mockResolvedValue(makeSearchResponse([]));
    const app = createApp(makeClient({ search }));

    await request(app).get('/search?limit=9999');

    const { body } = search.mock.calls[0][0];
    expect(body.size).toBe(100);
  });

  test('returns hits and next_search_after cursor', async () => {
    const search = jest
      .fn()
      .mockResolvedValue(
        makeSearchResponse([{ _id: 'prod-1', _source: { name: 'Headphones' }, sort: [1.5, 'prod-1'] }]),
      );
    const app = createApp(makeClient({ search }));

    const res = await request(app).get('/search?q=headphones');

    expect(res.body.total).toBe(1);
    expect(res.body.hits[0]).toMatchObject({ id: 'prod-1', name: 'Headphones' });
    expect(res.body.next_search_after).toEqual([1.5, 'prod-1']);
  });

  test('passes search_after to query when provided', async () => {
    const search = jest.fn().mockResolvedValue(makeSearchResponse([]));
    const app = createApp(makeClient({ search }));

    const cursor = JSON.stringify([1.5, 'prod-1']);
    await request(app).get(`/search?search_after=${encodeURIComponent(cursor)}`);

    const { body } = search.mock.calls[0][0];
    expect(body.search_after).toEqual([1.5, 'prod-1']);
  });

  test('next_search_after is null when result is empty', async () => {
    const search = jest.fn().mockResolvedValue(makeSearchResponse([]));
    const app = createApp(makeClient({ search }));

    const res = await request(app).get('/search');

    expect(res.body.next_search_after).toBeNull();
  });
});

describe('GET /search/advanced', () => {
  function makeSearchResponse(aggs = {}) {
    return okResponse({ hits: { total: { value: 0 }, hits: [] }, aggregations: aggs });
  }

  test('adds category term filter when category is provided', async () => {
    const search = jest.fn().mockResolvedValue(makeSearchResponse());
    const app = createApp(makeClient({ search }));

    await request(app).get('/search/advanced?category=electronics');

    const { body } = search.mock.calls[0][0];
    expect(body.query.bool.filter).toContainEqual({ term: { category: 'electronics' } });
  });

  test('adds price range filter when minPrice and maxPrice are provided', async () => {
    const search = jest.fn().mockResolvedValue(makeSearchResponse());
    const app = createApp(makeClient({ search }));

    await request(app).get('/search/advanced?minPrice=10&maxPrice=200');

    const { body } = search.mock.calls[0][0];
    expect(body.query.bool.filter).toContainEqual({ range: { price: { gte: 10, lte: 200 } } });
  });

  test('adds inStock filter when inStock=true', async () => {
    const search = jest.fn().mockResolvedValue(makeSearchResponse());
    const app = createApp(makeClient({ search }));

    await request(app).get('/search/advanced?inStock=true');

    const { body } = search.mock.calls[0][0];
    expect(body.query.bool.filter).toContainEqual({ term: { inStock: true } });
  });

  test('uses must multi_match when q is provided', async () => {
    const search = jest.fn().mockResolvedValue(makeSearchResponse());
    const app = createApp(makeClient({ search }));

    await request(app).get('/search/advanced?q=keyboard');

    const { body } = search.mock.calls[0][0];
    expect(body.query.bool.must[0].multi_match.query).toBe('keyboard');
  });

  test('returns aggregations in response', async () => {
    const aggs = { by_category: { buckets: [{ key: 'electronics', doc_count: 3 }] } };
    const search = jest.fn().mockResolvedValue(makeSearchResponse(aggs));
    const app = createApp(makeClient({ search }));

    const res = await request(app).get('/search/advanced');

    expect(res.body.aggregations).toEqual(aggs);
  });
});

describe('withRetry', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('returns result immediately on success', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    await expect(withRetry(fn, 3)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('retries on 429 and succeeds on second attempt', async () => {
    const fn = jest.fn().mockRejectedValueOnce(makeResponseError(429)).mockResolvedValue('ok');

    const promise = withRetry(fn, 3);
    await jest.runAllTimersAsync();

    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('throws immediately on non-429 error', async () => {
    const err = makeResponseError(500);
    const fn = jest.fn().mockRejectedValue(err);
    await expect(withRetry(fn, 3)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('throws after exhausting all attempts on repeated 429', async () => {
    const fn = jest.fn().mockRejectedValue(makeResponseError(429));

    // Attach .catch immediately to avoid PromiseRejectionHandledWarning.
    let caught: unknown;
    const promise = withRetry(fn, 3).catch((e) => {
      caught = e;
    });
    await jest.runAllTimersAsync();
    await promise;

    expect(caught).toBeInstanceOf(errors.ResponseError);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

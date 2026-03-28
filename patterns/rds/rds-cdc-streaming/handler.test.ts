import { KinesisStreamEvent } from 'aws-lambda';
import { DynamoDBClient, PutItemCommand, ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';

// Mock the DynamoDB client before importing the handler so the module picks up the mock.
jest.mock('@aws-sdk/client-dynamodb');

const mockSend = jest.fn();
(DynamoDBClient as jest.Mock).mockImplementation(() => ({ send: mockSend }));

// Import after mocking so the handler's module-level DynamoDBClient uses the mock.
import { handler } from './handler';

process.env.DEDUP_TABLE_NAME = 'test-dedup-table';

// Encode a DMS CDC record as a Kinesis record payload (base64 JSON).
function makeKinesisRecord(
  overrides: Partial<{
    id: number | string;
    text: string;
    operation: string;
    recordType: string;
    sequenceNumber: string;
  }> = {},
) {
  const {
    id = 1,
    text = 'Test quote',
    operation = 'insert',
    recordType = 'data',
    sequenceNumber = 'seq-001',
  } = overrides;
  const payload = {
    data: { id, text, author: 'Alice', created_at: '2026-01-01T00:00:00Z' },
    metadata: {
      timestamp: '2026-01-01T00:00:00Z',
      'record-type': recordType,
      operation,
      'partition-key-type': 'schema-table-type',
      'schema-name': 'public',
      'table-name': 'quotes',
      'transaction-id': 42,
    },
  };
  return {
    kinesis: {
      sequenceNumber,
      data: Buffer.from(JSON.stringify(payload)).toString('base64'),
      approximateArrivalTimestamp: Date.now() / 1000,
      partitionKey: 'public.quotes.1',
      kinesisSchemaVersion: '1.0',
    },
    eventSource: 'aws:kinesis',
    eventSourceARN: 'arn:aws:kinesis:eu-central-1:123456789012:stream/rds-cdc-stream',
    eventID: 'shardId-000000000000:seq-001',
    eventVersion: '1.0',
    eventName: 'aws:kinesis:record',
    invokeIdentityArn: 'arn:aws:iam::123456789012:role/test',
    awsRegion: 'eu-central-1',
  };
}

describe('CDC Lambda handler', () => {
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation();
    errorSpy = jest.spyOn(console, 'error').mockImplementation();
    mockSend.mockReset();
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('processes an INSERT record — writes to DynamoDB and logs the event', async () => {
    mockSend.mockResolvedValueOnce({});

    const event = { Records: [makeKinesisRecord({ id: 1, operation: 'insert' })] } as KinesisStreamEvent;
    const result = await handler(event);

    expect(mockSend).toHaveBeenCalledWith(expect.any(PutItemCommand));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"operation":"insert"'));
    expect(result.batchItemFailures).toHaveLength(0);
  });

  test('skips duplicate record — ConditionalCheckFailedException → not in batchItemFailures', async () => {
    const err = new ConditionalCheckFailedException({ message: 'conditional check failed', $metadata: {} });
    mockSend.mockRejectedValueOnce(err);

    const event = { Records: [makeKinesisRecord({ id: 2, sequenceNumber: 'seq-002' })] } as KinesisStreamEvent;
    const result = await handler(event);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Duplicate skipped: seq=seq-002'));
    // Duplicate should NOT be returned as a failure — no retry.
    expect(result.batchItemFailures).toHaveLength(0);
  });

  test('adds to batchItemFailures on unexpected DynamoDB error', async () => {
    mockSend.mockRejectedValueOnce(new Error('ProvisionedThroughputExceededException'));

    const event = { Records: [makeKinesisRecord({ id: 3, sequenceNumber: 'seq-003' })] } as KinesisStreamEvent;
    const result = await handler(event);

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'seq-003' }]);
  });

  test('poison-pill record (text contains [POISON_PILL]) → returned in batchItemFailures', async () => {
    const event = {
      Records: [makeKinesisRecord({ text: '[POISON_PILL] bad record', sequenceNumber: 'seq-004' })],
    } as KinesisStreamEvent;
    const result = await handler(event);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed: seq=seq-004'), expect.any(Error));
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'seq-004' }]);
    // DynamoDB should NOT have been called for a poison-pill record.
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('skips control records (record-type !== data)', async () => {
    const event = {
      Records: [makeKinesisRecord({ recordType: 'control', sequenceNumber: 'seq-005' })],
    } as KinesisStreamEvent;
    const result = await handler(event);

    expect(mockSend).not.toHaveBeenCalled();
    expect(result.batchItemFailures).toHaveLength(0);
  });

  test('processes a batch with mixed success — only failed records in batchItemFailures', async () => {
    // Record 1: success
    mockSend.mockResolvedValueOnce({});
    // Record 2: unexpected error
    mockSend.mockRejectedValueOnce(new Error('network error'));

    const event = {
      Records: [
        makeKinesisRecord({ id: 10, sequenceNumber: 'seq-010' }),
        makeKinesisRecord({ id: 11, sequenceNumber: 'seq-011' }),
      ],
    } as KinesisStreamEvent;
    const result = await handler(event);

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'seq-011' }]);
  });
});

import { KinesisStreamEvent, KinesisStreamBatchResponse } from 'aws-lambda';
import { DynamoDBClient, PutItemCommand, ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';

const dynamo = new DynamoDBClient({});
const DEDUP_TABLE = process.env.DEDUP_TABLE_NAME!;

// DMS writes CDC events to Kinesis as JSON. Each record has `data` (row values)
// and `metadata` (operation type, table name, transaction info).
interface DmsCdcRecord {
  data: Record<string, unknown>;
  metadata: {
    timestamp: string;
    'record-type': 'data' | 'control';
    operation: 'load' | 'insert' | 'update' | 'delete';
    'partition-key-type': string;
    'schema-name': string;
    'table-name': string;
    'transaction-id'?: number;
  };
}

// The handler receives a batch of Kinesis records from the DMS CDC stream.
// It deduplicates each record using DynamoDB before processing, guarding against
// at-least-once delivery. Records that fail are returned in batchItemFailures
// so Lambda retries only those — not the whole batch (partial batch response).
export const handler = async (event: KinesisStreamEvent): Promise<KinesisStreamBatchResponse> => {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    const sequenceNumber = record.kinesis.sequenceNumber;

    try {
      // Kinesis payloads are base64-encoded by the event source mapping.
      const payload = Buffer.from(record.kinesis.data, 'base64').toString('utf-8');
      const cdcRecord: DmsCdcRecord = JSON.parse(payload);

      // DMS also sends 'control' records (schema metadata events). Skip them —
      // only 'data' records carry actual row changes.
      if (cdcRecord.metadata['record-type'] !== 'data') {
        continue;
      }

      // Build an idempotency key that is stable across Lambda retries of the same CDC event.
      // transaction-id is included because the same row can be modified in multiple transactions.
      const schema = cdcRecord.metadata['schema-name'];
      const table = cdcRecord.metadata['table-name'];
      const pk = cdcRecord.data['id'] ?? sequenceNumber; // fall back to sequence number if no id
      const op = cdcRecord.metadata['operation'];
      const txnId = cdcRecord.metadata['transaction-id'] ?? 0;
      const eventId = `${schema}.${table}.${pk}.${op}.${txnId}`;

      // DEMO FAILURE SIMULATION: throw on records whose text contains "[POISON_PILL]".
      // Tests bisect-on-error behavior — splits the batch in half and retries each half.
      if (String(cdcRecord.data['text'] ?? '').includes('[POISON_PILL]')) {
        throw new Error(`Poison pill: ${eventId}`);
      }

      // DynamoDB conditional write: the PutItem fails with ConditionalCheckFailedException
      // if the eventId already exists. This makes processing idempotent — a Lambda retry
      // caused by Kinesis at-least-once delivery will skip already-processed records.
      // TTL of 24 hours prevents the dedup table from growing unboundedly.
      const expiresAt = Math.floor(Date.now() / 1000) + 86400; // now + 24h in Unix seconds
      await dynamo.send(
        new PutItemCommand({
          TableName: DEDUP_TABLE,
          Item: {
            eventId: { S: eventId },
            operation: { S: op },
            tableName: { S: `${schema}.${table}` },
            processedAt: { S: new Date().toISOString() },
            expiresAt: { N: String(expiresAt) },
          },
          ConditionExpression: 'attribute_not_exists(eventId)',
        }),
      );

      // Plug-in point: replace this log with SES SendEmail, SNS Publish, etc.
      console.log(
        JSON.stringify({
          eventId,
          operation: op,
          table: `${schema}.${table}`,
          data: cdcRecord.data,
          timestamp: cdcRecord.metadata.timestamp,
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        // Duplicate event — already processed. Skip without retrying.
        console.log(`Duplicate skipped: seq=${sequenceNumber}`);
        continue;
      }
      // Any other error: add to failures so Lambda retries this record.
      console.error(`Failed: seq=${sequenceNumber}`, err);
      batchItemFailures.push({ itemIdentifier: sequenceNumber });
    }
  }

  // Returning batchItemFailures instructs Lambda to retry only the failed records,
  // not the entire batch. Without this, a single failure re-processes all records
  // in the batch — causing duplicate log entries and wasted DynamoDB writes.
  return { batchItemFailures };
};

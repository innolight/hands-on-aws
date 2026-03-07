import {DynamoDBStreamEvent} from 'aws-lambda';
import {unmarshall} from '@aws-sdk/util-dynamodb';
import {AttributeValue} from '@aws-sdk/client-dynamodb';

// The handler receives a batch of records from the DynamoDB stream.
// If any record in the batch causes an unhandled error, the entire batch
// is retried (or bisected) according to the EventSourceMapping config.
export const handler = async (event: DynamoDBStreamEvent): Promise<void> => {
  console.log(`Processing ${event.Records.length} records...`);

  for (const record of event.Records) {
    console.log('--- Record start ---');
    console.log(`EventID: ${record.eventID}`);
    console.log(`EventName: ${record.eventName}`);

    // unmarshall converts DynamoDB JSON format (e.g. { "S": "val" }) 
    // to standard JavaScript objects (e.g. { key: "val" }).
    const oldImage = record.dynamodb?.OldImage 
      ? unmarshall(record.dynamodb.OldImage as Record<string, AttributeValue>) 
      : null;
    const newImage = record.dynamodb?.NewImage 
      ? unmarshall(record.dynamodb.NewImage as Record<string, AttributeValue>) 
      : null;

    console.log('Old Image:', JSON.stringify(oldImage, null, 2));
    console.log('New Image:', JSON.stringify(newImage, null, 2));

    // DEMO BUSINESS LOGIC:
    // Detect if an order changed from 'PENDING' to 'PAID'.
    if (record.eventName === 'MODIFY' && oldImage && newImage) {
      if (oldImage.status === 'PENDING' && newImage.status === 'PAID') {
        console.log(`[ACTION] Order ${newImage.orderId} was PAID! Sending confirmation...`);
        // In a real system, you might trigger an SNS notification or a 3rd party API here.
      }
    }

    // DEMO FAILURE HANDLING (for 'bisectBatchOnFunctionError' testing):
    // Trigger a simulated error if an orderId contains "FAIL".
    if (newImage?.orderId?.includes('FAIL')) {
      console.error(`Simulating failure for order: ${newImage.orderId}`);
      throw new Error(`Poison pill detected: ${newImage.orderId}`);
    }

    console.log('--- Record end ---');
  }
};

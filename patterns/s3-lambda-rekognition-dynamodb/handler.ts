import { RekognitionClient, DetectLabelsCommand } from '@aws-sdk/client-rekognition';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { S3Event } from 'aws-lambda';

const rekognition = new RekognitionClient({});
const dynamodb = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME!;

export async function handler(event: S3Event): Promise<void> {
  // S3 event notifications typically batch 1 record per invocation
  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

    // DetectLabels is one of several Rekognition APIs. Other use cases such as:
    // - DetectText: OCR on worksheets or flashcard images
    // - DetectFaces: emotion detection for engagement analysis
    // - DetectModerationLabels: content safety for users uploaded images
    // - RecognizeCelebrities: identify historical figures in photos
    const detectResponse = await rekognition.send(
      new DetectLabelsCommand({
        Image: { S3Object: { Bucket: bucket, Name: key } },
        MaxLabels: 10,
        MinConfidence: 70,
        Settings: {
          GeneralLabels: {
            LabelCategoryInclusionFilters: ['Animals and Pets'],
          },
        },
      }),
    );

    const labels = (detectResponse.Labels ?? []).map((l) => ({
      M: {
        name: { S: l.Name ?? 'Unknown' },
        confidence: { N: String(l.Confidence ?? 0) },
      },
    }));

    await dynamodb.send(
      new PutItemCommand({
        TableName: TABLE_NAME,
        Item: {
          imageKey: { S: key },
          bucket: { S: bucket },
          labels: { L: labels },
          processedAt: { S: new Date().toISOString() },
        },
      }),
    );
  }
}

import express from "express";
import {PutObjectCommand, S3Client} from "@aws-sdk/client-s3";
import {DeleteMessageCommand, ReceiveMessageCommand, SQSClient} from "@aws-sdk/client-sqs";
import {getStackOutputs} from "../../utils";
import {s3EventsNotificationStackName} from "./stack";

const app = express();
const PORT = process.env.PORT || 3000;
const s3Client = new S3Client({region: process.env.AWS_REGION});
const sqsClient = new SQSClient({region: process.env.AWS_REGION});

let BUCKET_NAME, SQS_QUEUE_URL;
(async () => {
  const result = await getStackOutputs(s3EventsNotificationStackName)
  console.log(`StackOutput for ${s3EventsNotificationStackName}:`, result)
  BUCKET_NAME = result["S3BucketName"];
  SQS_QUEUE_URL = result["SQSQueueUrl"]
})()

app.use(express.json());

// API to upload JSON file to S3
app.post("/s3-file-uploads", async (req, res) => {
  try {
    const jsonData = JSON.stringify(req.body);
    const key = `${Date.now()}.json`;

    const uploadParams = {
      Bucket: BUCKET_NAME,
      Key: key,
      Body: jsonData,
      ContentType: "application/json",
    };

    const command = new PutObjectCommand(uploadParams);
    await s3Client.send(command);

    res.json({message: "File uploaded successfully", key});
  } catch (error) {
    console.error("Error uploading file:", error);
    res.status(500).json({error: "Error uploading file"});
  }
});

// API to read a message from SQS
app.get("/sqs/s3-events", async (req, res) => {
  try {
    const command = new ReceiveMessageCommand({
      QueueUrl: SQS_QUEUE_URL,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 10,
    });

    const response = await sqsClient.send(command);
    if (response.Messages && response.Messages.length > 0) {
      const message = response.Messages[0];

      // Delete the message after processing
      const deleteCommand = new DeleteMessageCommand({
        QueueUrl: SQS_QUEUE_URL,
        ReceiptHandle: message.ReceiptHandle!,
      });
      await sqsClient.send(deleteCommand);

      res.json({
        message: JSON.parse(message.Body!), // todo: handle exception from JSON.parse
        status: "Message processed and deleted"
      });
    } else {
      res.json({message: "No messages available"});
    }
  } catch (error) {
    console.error("Error reading message from queue:", error);
    res.status(500).json({error: "Error reading message"});
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

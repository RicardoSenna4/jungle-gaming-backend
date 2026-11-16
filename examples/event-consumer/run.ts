import { Client } from 'pg';
import { SQSClient, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { ReferenceEventConsumer, schema } from './consumer';
if (!process.env.REFERENCE_DATABASE_URL || !process.env.REFERENCE_QUEUE_URL)
  throw new Error('REFERENCE_TARGET_REQUIRED');
const db = new Client({ connectionString: process.env.REFERENCE_DATABASE_URL });
await db.connect();
if (process.env.REFERENCE_INSTALL_SCHEMA === '1') await db.query(schema);
const sqs = new SQSClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
  ...(process.env.SQS_ENDPOINT
    ? {
        endpoint: process.env.SQS_ENDPOINT,
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
        },
      }
    : {}),
});
let stopping = false;
process.once('SIGTERM', () => {
  stopping = true;
});
process.once('SIGINT', () => {
  stopping = true;
});
const consumer = new ReferenceEventConsumer(db, sqs, process.env.REFERENCE_QUEUE_URL);
try {
  while (!stopping) {
    const messages = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: process.env.REFERENCE_QUEUE_URL,
        WaitTimeSeconds: 1,
        MaxNumberOfMessages: 1,
      }),
    );
    for (const message of messages.Messages ?? [])
      try {
        await consumer.handle(message);
      } catch {
        console.error('REFERENCE_PROCESSING_FAILED_RETRY');
        await new Promise((r) => setTimeout(r, 250));
      }
  }
} finally {
  sqs.destroy();
  await db.end();
}

import { Client } from 'pg';
import { SQSClient, ReceiveMessageCommand, Message } from '@aws-sdk/client-sqs';
import { ReferenceEventConsumer } from '../../examples/event-consumer/consumer';
if (
  process.env.NODE_ENV !== 'test' ||
  !process.env.DB_NAME?.startsWith('reference_') ||
  process.env.DB_HOST !== 'localhost' ||
  new URL(process.env.SQS_ENDPOINT!).hostname !== 'localhost' ||
  process.env.AWS_ACCESS_KEY_ID !== 'test'
)
  throw new Error('ISOLATED_TEST_ONLY');
const db = new Client({
  host: 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER ?? 'postgres',
  password: process.env.DB_PASSWORD ?? 'postgres',
  database: process.env.DB_NAME,
});
await db.connect();
const sqs = new SQSClient({
  region: 'us-east-1',
  endpoint: process.env.SQS_ENDPOINT,
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});
class Observed extends ReferenceEventConsumer {
  protected override async ack(message: Message) {
    console.log(JSON.stringify({ checkpoint: 'sent', pid: process.pid }));
    if (process.argv[2] === 'pause')
      await new Promise<never>(() => {
        setInterval(() => {}, 1000);
      });
    await super.ack(message);
    console.log(JSON.stringify({ checkpoint: 'marked', pid: process.pid }));
  }
}
const messages = await sqs.send(
  new ReceiveMessageCommand({ QueueUrl: process.env.SQS_QUEUE_URL, WaitTimeSeconds: 2 }),
);
if (!messages.Messages?.[0]) throw new Error('NO_MESSAGE');
await new Observed(db, sqs, process.env.SQS_QUEUE_URL!).handle(messages.Messages[0]);
await db.end();
sqs.destroy();

import { worker } from '../helpers/outbox-process';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  SQSClient,
  CreateQueueCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { ReferenceEventConsumer, schema } from '../../examples/event-consumer/consumer';
const suite =
  process.env.RUN_INTEGRATION === '1' && process.env.RUN_SQS_REAL === '1'
    ? describe
    : describe.skip;
suite('Didactic persistent event consumer (real PostgreSQL/LocalStack)', () => {
  let admin: Client;
  let clients: Client[];
  let sqs: SQSClient;
  let queue: string;
  let name: string;
  beforeAll(async () => {
    name = `reference_${randomUUID().replaceAll('-', '')}`;
    const options = {
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USER ?? 'postgres',
      password: process.env.DB_PASSWORD ?? 'postgres',
    };
    admin = new Client({ ...options, database: process.env.DB_NAME ?? 'jungle' });
    await admin.connect();
    await admin.query(`create database "${name}"`);
    clients = Array.from({ length: 3 }, () => new Client({ ...options, database: name }));
    for (const c of clients) await c.connect();
    await clients[0]!.query(schema);
    sqs = new SQSClient({
      region: 'us-east-1',
      endpoint: 'http://localhost:4566',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    queue = (
      await sqs.send(
        new CreateQueueCommand({
          QueueName: `reference-${randomUUID()}.fifo`,
          Attributes: {
            FifoQueue: 'true',
            ContentBasedDeduplication: 'false',
            VisibilityTimeout: '1',
          },
        }),
      )
    ).QueueUrl!;
  });
  afterAll(async () => {
    await sqs.send(new DeleteQueueCommand({ QueueUrl: queue }));
    sqs.destroy();
    for (const c of clients) await c.end();
    await admin.query(`drop database "${name}"`);
    await admin.end();
  });
  const event = () =>
    JSON.stringify({
      eventId: randomUUID(),
      eventType: 'WalletBalanceChanged',
      version: 1,
      aggregateId: randomUUID(),
      correlationId: 'reference',
      occurredAt: new Date().toISOString(),
      data: { walletVersion: 2 },
    });
  async function receive() {
    return (
      (
        await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queue,
            WaitTimeSeconds: 1,
            MaxNumberOfMessages: 10,
          }),
        )
      ).Messages ?? []
    );
  }
  it('serializes duplicate effects across independent connections and acknowledges after commit', async () => {
    const body = event();
    const messages = [];
    for (let i = 0; i < 3; i++) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queue,
          MessageBody: body,
          MessageGroupId: randomUUID(),
          MessageDeduplicationId: randomUUID(),
        }),
      );
      messages.push(...(await receive()));
    }
    expect(messages).toHaveLength(3);
    await Promise.all(
      messages.map((m, i) => new ReferenceEventConsumer(clients[i]!, sqs, queue).handle(m)),
    );
    expect((await clients[0]!.query('select * from reference_events.effects')).rowCount).toBe(1);
    expect(await receive()).toHaveLength(0);
  });
  it('persists invalid input before ACK and rolls back transient processing failures', async () => {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queue,
        MessageBody: '{invalid',
        MessageGroupId: randomUUID(),
        MessageDeduplicationId: randomUUID(),
      }),
    );
    const invalid = await receive();
    expect(await new ReferenceEventConsumer(clients[0]!, sqs, queue).handle(invalid[0]!)).toBe(
      'invalid',
    );
    expect((await clients[0]!.query('select * from reference_events.invalid')).rowCount).toBe(1);
    const body = event();
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queue,
        MessageBody: body,
        MessageGroupId: randomUUID(),
        MessageDeduplicationId: randomUUID(),
      }),
    );
    const message = (await receive())[0]!;
    await clients[0]!.query(
      "create function reference_events.reject_effect() returns trigger language plpgsql as $$ begin raise exception 'test transient';end $$;create trigger reject_effect before insert on reference_events.effects for each row execute function reference_events.reject_effect()",
    );
    try {
      await expect(
        new ReferenceEventConsumer(clients[1]!, sqs, queue).handle(message),
      ).rejects.toThrow('test transient');
      expect(
        (
          await clients[0]!.query('select * from reference_events.processed where event_id=$1', [
            JSON.parse(body).eventId,
          ])
        ).rowCount,
      ).toBe(0);
    } finally {
      await clients[0]!.query(
        'drop trigger reject_effect on reference_events.effects;drop function reference_events.reject_effect()',
      );
    }
    await new Promise((r) => setTimeout(r, 1100));
    const retry = (await receive())[0]!;
    expect(retry).toBeDefined();
    await new ReferenceEventConsumer(clients[2]!, sqs, queue).handle(retry);
  });
  it('survives a real process kill after projection commit before ACK', async () => {
    const body = event();
    const id = JSON.parse(body).eventId;
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queue,
        MessageBody: body,
        MessageGroupId: randomUUID(),
        MessageDeduplicationId: randomUUID(),
      }),
    );
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      DB_HOST: 'localhost',
      DB_NAME: name,
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
      SQS_ENDPOINT: 'http://localhost:4566',
      SQS_QUEUE_URL: queue,
    };
    const first = worker(env, 'pause', 'test/fixtures/reference-event-worker.ts');
    let second: ReturnType<typeof worker> | undefined;
    try {
      await first.wait('sent');
      expect(
        (await clients[0]!.query('select * from reference_events.effects where event_id=$1', [id]))
          .rowCount,
      ).toBe(1);
      first.child.kill('SIGKILL');
      expect((await first.exited).signal).toBe('SIGKILL');
      await new Promise((r) => setTimeout(r, 1100));
      second = worker(env, 'resume', 'test/fixtures/reference-event-worker.ts');
      await second.wait('marked');
      expect(
        (await clients[0]!.query('select * from reference_events.effects where event_id=$1', [id]))
          .rowCount,
      ).toBe(1);
      expect(await receive()).toHaveLength(0);
    } finally {
      await first.stop();
      await second?.stop();
    }
  });
});

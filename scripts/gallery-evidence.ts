import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  SQSClient,
  CreateQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteQueueCommand,
} from '@aws-sdk/client-sqs';
import { ReferenceEventConsumer, schema } from '../examples/event-consumer/consumer';

if (
  process.env.GALLERY_DEMO !== '1' ||
  process.env.DB_NAME !== 'jungle_load_test' ||
  process.env.DB_HOST !== 'postgres' ||
  process.env.SQS_ENDPOINT !== 'http://localstack:4566' ||
  !/^[a-f0-9]{40}$/.test(process.env.GALLERY_SOURCE_COMMIT ?? '')
)
  throw new Error('Run only inside the dedicated gallery Compose');

const base = 'http://localhost:3000';
const dbConfig = {
  host: 'postgres',
  database: 'jungle_load_test',
  user: 'postgres',
  password: 'postgres',
};
const db = new Client(dbConfig);
const other = new Client(dbConfig);
const sqs = new SQSClient({
  endpoint: process.env.SQS_ENDPOINT,
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});
const run = randomUUID();
async function post(path: string, body: unknown, key?: string) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`Gallery request failed: ${path}, ${response.status}`);
  return { httpStatus: response.status, body: result };
}
let queue: string | undefined;
await db.connect();
await other.connect();
try {
  const created = await post('/wallets', {
    playerId: `gallery-financial-${run}`,
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  const wallet = created.body as { id: string; playerId: string };
  const body = {
    providerId: 'gallery-demo',
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'gallery-round',
    gameId: 'gallery-game',
    externalTransactionId: `gallery-bet-${run}`,
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  };
  const key = `gallery-key-${run}`;
  const bet = await post('/wagering/transactions', body, key);
  const replays = await Promise.all(
    Array.from({ length: 5 }, () => post('/wagering/transactions', body, key)),
  );
  const final = (await (await fetch(`${base}/wallets/${wallet.id}`)).json()) as {
    balance: { amount: string };
    version: number;
  };
  const reconciliation = await post(`/wallets/${wallet.id}/reconciliation`, {});
  const { rows: counts } = await db.query(
    "select (select count(*)::int from wager_transactions where wallet_id=$1 and kind='BET') as bets,(select count(*)::int from wallet_ledger_entries where wallet_id=$1) as ledger_entries",
    [wallet.id],
  );
  if (
    final.balance.amount !== '75.00' ||
    final.version !== 2 ||
    counts[0].bets !== 1 ||
    counts[0].ledger_entries !== 2 ||
    !(reconciliation.body as { consistent: boolean }).consistent
  )
    throw new Error('Financial invariant failed');
  const id = (bet.body as { transactionId: string }).transactionId;
  if (
    !replays.every(
      (r) =>
        (r.body as { idempotentReplay: boolean; transactionId: string }).idempotentReplay &&
        (r.body as { transactionId: string }).transactionId === id,
    )
  )
    throw new Error('Replay invariant failed');

  // Take an actual message published by the running Outbox worker.
  let message: { Body?: string } | undefined;
  for (let i = 0; i < 30 && !message; i++) {
    const response = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: process.env.SQS_EVENTS_QUEUE_URL,
        WaitTimeSeconds: 1,
        MaxNumberOfMessages: 1,
      }),
    );
    message = response.Messages?.[0];
  }
  if (!message?.Body) throw new Error('Outbox event not received in real SQS');
  const envelope = JSON.parse(message.Body) as { eventId: string };
  queue = (
    await sqs.send(
      new CreateQueueCommand({
        QueueName: `gallery-reference-${run}.fifo`,
        Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
      }),
    )
  ).QueueUrl!;
  await db.query(schema);
  await Promise.all(
    [0, 1].map((n) =>
      sqs.send(
        new SendMessageCommand({
          QueueUrl: queue,
          MessageBody: message!.Body,
          MessageGroupId: `copy-${n}`,
          MessageDeduplicationId: randomUUID(),
        }),
      ),
    ),
  );
  const received = [];
  for (let i = 0; i < 10 && received.length < 2; i++) {
    received.push(
      ...((
        await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queue,
            WaitTimeSeconds: 1,
            MaxNumberOfMessages: 2,
          }),
        )
      ).Messages ?? []),
    );
  }
  if (received.length !== 2 || received[0].MessageId === received[1].MessageId)
    throw new Error('Two distinct SQS deliveries required');
  const snapshot = async () =>
    JSON.stringify(
      (
        await db.query(
          'select balance::text,version,(select count(*) from wallet_ledger_entries where wallet_id=$1) as ledger from wallets where id=$1',
          [wallet.id],
        )
      ).rows,
    );
  const before = await snapshot();
  const results = await Promise.all([
    new ReferenceEventConsumer(db, sqs, queue).handle(received[0]),
    new ReferenceEventConsumer(other, sqs, queue).handle(received[1]),
  ]);
  const { rows: dedup } = await db.query(
    'select (select count(*)::int from reference_events.processed where event_id=$1) as processed,(select count(*)::int from reference_events.effects where event_id=$1) as effects',
    [envelope.eventId],
  );
  if (
    dedup[0].processed !== 1 ||
    dedup[0].effects !== 1 ||
    before !== (await snapshot()) ||
    results.some((s) => s !== 'processed')
  )
    throw new Error('Persistent deduplication failed');
  const remaining =
    (
      await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: queue, WaitTimeSeconds: 1, MaxNumberOfMessages: 2 }),
      )
    ).Messages ?? [];
  if (remaining.length) throw new Error('Acknowledged messages still visible');
  console.log(
    JSON.stringify(
      {
        sourceCommit: process.env.GALLERY_SOURCE_COMMIT,
        capturedAt: new Date().toISOString(),
        environment: 'Disposable Docker Compose / challenge / synthetic data',
        financial: {
          created,
          request: { endpoint: 'POST /wagering/transactions', body },
          bet,
          replays,
          final,
          reconciliation,
          sql: counts[0],
        },
        deduplication: {
          eventId: envelope.eventId,
          receivedMessageIds: received.map((m) => m.MessageId),
          simultaneousConsumers: 2,
          persistedEvents: dedup[0].processed,
          projectionEffects: dedup[0].effects,
          handlersCompletedAfterAck: results.length,
          visibleAfterAck: remaining.length,
          financialSnapshotUnchanged: true,
          deliveryGuarantee: 'at-least-once',
        },
      },
      null,
      2,
    ),
  );
} finally {
  if (queue) await sqs.send(new DeleteQueueCommand({ QueueUrl: queue }));
  sqs.destroy();
  await db.end();
  await other.end();
}

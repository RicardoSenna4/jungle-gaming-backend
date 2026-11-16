import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { SQSClient, SendMessageCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
if (process.env.DB_NAME !== 'jungle_load_test' || process.env.DB_HOST !== 'postgres')
  throw new Error('Disposable performance database required');
const db = new Client({
  host: 'postgres',
  database: 'jungle_load_test',
  user: 'postgres',
  password: 'postgres',
});
await db.connect();
const sqs = new SQSClient({
  endpoint: process.env.SQS_ENDPOINT,
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});
try {
  const wallet = (await (
    await fetch('http://localhost:3000/wallets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId: 'load-async',
        initialBalance: { amount: '1000.00', currency: 'BRL' },
      }),
    })
  ).json()) as { id: string };
  if (!wallet.id) throw new Error('Async wallet setup failed');
  const start = performance.now();
  await Promise.all(
    Array.from({ length: 20 }, async (_, i) => {
      const messageId = randomUUID();
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: process.env.SQS_QUEUE_URL,
          MessageGroupId: 'load-async',
          MessageDeduplicationId: messageId,
          MessageBody: JSON.stringify({
            messageId,
            type: 'WagerTransactionRequested',
            occurredAt: new Date().toISOString(),
            data: {
              idempotencyKey: messageId,
              externalTransactionId: messageId,
              providerId: 'load',
              walletId: wallet.id,
              playerId: 'load-async',
              roundId: 'load',
              gameId: 'load',
              kind: 'BET',
              money: { amount: '1.00', currency: 'BRL' },
            },
          }),
        }),
      );
    }),
  );
  let complete = false;
  while (performance.now() - start < 60000) {
    const { rows } = await db.query(
      "select (select count(*)::int from wager_transactions where wallet_id=$1 and status='PROCESSED' and kind='BET') as count,(select count(*)::int from outbox_messages where published_at is null) as pending",
      [wallet.id],
    );
    if (rows[0].count === 20 && rows[0].pending === 0) {
      complete = true;
      break;
    }
    await Bun.sleep(100);
  }
  if (!complete) throw new Error('Async processing/publication timed out');
  const asyncMs = performance.now() - start;
  const expected: Record<string, string> = {
    parallel: '3980.00',
    hot: '980.00',
    limited: '400.00',
    replays: '999.00',
    mixed: '4000.00',
    async: '980.00',
  };
  const totals: Record<string, string> = {};
  for (const [scenario, amount] of Object.entries(expected)) {
    const { rows } = await db.query(
      'select sum(balance)::text as balance from wallets where player_id like $1',
      [`load-${scenario}%`],
    );
    totals[scenario] = rows[0].balance;
    if (totals[scenario] !== amount)
      throw new Error(`Unexpected balance for ${scenario}: ${totals[scenario]}`);
  }
  const { rows: inconsistent } = await db.query(
    "select w.id from wallets w left join wallet_ledger_entries l on l.wallet_id=w.id group by w.id having w.balance < 0 or w.balance <> coalesce(sum(case when l.direction='CREDIT' then l.amount else -l.amount end),0)",
  );
  if (inconsistent.length) throw new Error('Ledger sum or nonnegative invariant failed');
  const { rows: wallets } = await db.query('select id from wallets');
  for (const w of wallets) {
    const r = await fetch(`http://localhost:3000/wallets/${w.id}/reconciliation`, {
      method: 'POST',
    });
    if (!r.ok || !((await r.json()) as { consistent: boolean }).consistent)
      throw new Error('Reconciliation failed');
  }
  const { rows: counts } = await db.query(
    'select (select count(*) from wallets) as wallets,(select count(*) from wager_transactions) as transactions,(select count(*) from inbox_messages where processed_at is not null) as inbox,(select count(*) from wallet_ledger_entries) as ledger,(select count(*) from outbox_messages where published_at is not null) as published',
  );
  if (Number(counts[0].inbox) !== 20) throw new Error('Inbox count mismatch');
  const broker = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: process.env.SQS_EVENTS_QUEUE_URL,
      AttributeNames: ['ApproximateNumberOfMessages'],
    }),
  );
  if (Number(broker.Attributes?.ApproximateNumberOfMessages) <= 0)
    throw new Error('No broker event publication observed');
  console.log(
    JSON.stringify({
      totals,
      counts: counts[0],
      asyncBatchCommitAndPublishMs: asyncMs,
      brokerEventMessages: broker.Attributes?.ApproximateNumberOfMessages,
      allWalletsReconciled: true,
    }),
  );
} finally {
  await db.end();
  sqs.destroy();
}

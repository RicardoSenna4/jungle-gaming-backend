import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { Client } from 'pg';
import { MikroORM } from '@mikro-orm/postgresql';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import config from '../../src/infrastructure/database/mikro-orm.config';
import { WalletRepository } from '../../src/application/wallets/wallet-repository';
import { Money } from '../../src/domain/money';

const describeIntegration =
  process.env.RUN_INTEGRATION === '1' && process.env.RUN_SQS_REAL === '1'
    ? describe
    : describe.skip;
interface Checkpoint {
  checkpoint: string;
  pid: number;
  brokerMessageId?: string;
  receiveCount?: number;
}
function worker(environment: NodeJS.ProcessEnv, mode: string) {
  const child = spawn(process.execPath, ['run', 'test/fixtures/inbox-ack-worker.ts', mode], {
    cwd: process.cwd(),
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const events: Checkpoint[] = [];
  const waiters: Array<{
    event: string;
    resolve: (value: Checkpoint) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  let buffered = '';
  child.stdout.on('data', (data: Buffer) => {
    buffered += data.toString();
    const lines = buffered.split('\n');
    buffered = lines.pop()!;
    for (const line of lines) {
      let event: Checkpoint;
      try {
        event = JSON.parse(line) as Checkpoint;
      } catch {
        continue;
      }
      events.push(event);
      for (const waiter of [...waiters])
        if (waiter.event === event.checkpoint) {
          clearTimeout(waiter.timer);
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(event);
        }
    }
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('WORKER_EXITED_BEFORE_CHECKPOINT'));
      }
      resolve({ code, signal });
    }),
  );
  child.once('error', () => {
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('WORKER_START_FAILED'));
    }
  });
  const wait = (event: string) => {
    const seen = events.find((value) => value.checkpoint === event);
    if (seen) return Promise.resolve(seen);
    return new Promise<Checkpoint>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MISSING_CHECKPOINT_${event}`)), 15000);
      waiters.push({ event, resolve, reject, timer });
    });
  };
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.kill('SIGTERM');
    await exited;
    clearTimeout(timeout);
  };
  return { child, wait, exited, stop };
}

describeIntegration('Real process crash between Inbox commit and SQS ACK', () => {
  it('kills a committed consumer before ACK, observes redelivery after visibility and preserves one financial effect', async () => {
    const run = randomUUID().replaceAll('-', '');
    const dbName = `jungle_ack_test_${run}`;
    const admin = new Client({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USER ?? 'postgres',
      password: process.env.DB_PASSWORD ?? 'postgres',
      database: process.env.DB_NAME ?? 'jungle',
    });
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    const orm = await MikroORM.init({
      ...config,
      dbName,
      migrations: { ...config.migrations, snapshot: false },
    });
    const sqs = new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    let queue: string | undefined;
    let dlq: string | undefined;
    let first: ReturnType<typeof worker> | undefined;
    let restarted: ReturnType<typeof worker> | undefined;
    try {
      await orm.getMigrator().up();
      queue = (
        await sqs.send(
          new CreateQueueCommand({
            QueueName: `ack-${run}.fifo`,
            Attributes: {
              FifoQueue: 'true',
              ContentBasedDeduplication: 'false',
              VisibilityTimeout: '3',
            },
          }),
        )
      ).QueueUrl!;
      dlq = (
        await sqs.send(
          new CreateQueueCommand({
            QueueName: `ack-dlq-${run}.fifo`,
            Attributes: { FifoQueue: 'true' },
          }),
        )
      ).QueueUrl!;
      const wallet = await new WalletRepository(orm.em.fork()).create(
        'ack-test-player',
        Money.from({ amount: '100.00', currency: 'BRL' }),
      );
      const semanticId = randomUUID();
      const consumerName = `ack-proof-${run}`;
      const body = JSON.stringify({
        messageId: semanticId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: {
          providerId: 'ack-provider',
          externalTransactionId: `ack-external-${run}`,
          idempotencyKey: `ack-key-${run}`,
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: 'ack-round',
          gameId: 'ack-game',
          kind: 'BET',
          money: { amount: '25.00', currency: 'BRL' },
        },
      });
      const sent = await sqs.send(
        new SendMessageCommand({
          QueueUrl: queue,
          MessageBody: body,
          MessageGroupId: wallet.id,
          MessageDeduplicationId: randomUUID(),
        }),
      );
      const environment = {
        ...process.env,
        NODE_ENV: 'test',
        AUTH_MODE: 'challenge',
        DB_HOST: process.env.DB_HOST ?? 'localhost',
        DB_NAME: dbName,
        INBOX_ACK_TEST_RUN_ID: run,
        AWS_ACCESS_KEY_ID: 'test',
        AWS_SECRET_ACCESS_KEY: 'test',
        SQS_ENDPOINT: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
        SQS_QUEUE_URL: queue,
        SQS_DLQ_QUEUE_URL: dlq,
        SQS_CONSUMER_NAME: consumerName,
        SQS_VISIBILITY_TIMEOUT: '3',
        SQS_MAX_IN_FLIGHT: '1',
        ENABLE_SQS_CONSUMER: 'false',
        ENABLE_OUTBOX_PUBLISHER: 'false',
        ENABLE_PENDING_REFERENCE_WORKER: 'false',
      };
      first = worker(environment, 'pause');
      const beforeAck = await first.wait('before-ack');
      expect(beforeAck.pid).toBe(first.child.pid);
      expect(beforeAck.pid).not.toBe(process.pid);
      expect(beforeAck.brokerMessageId).toBe(sent.MessageId);
      expect(beforeAck.receiveCount).toBe(1);
      const snapshot = async () => ({
        wallets: await orm.em
          .getConnection()
          .execute('select balance::text,version from wallets where id = ?', [wallet.id]),
        transactions: await orm.em
          .getConnection()
          .execute("select id,status,response_snapshot from wager_transactions where kind = 'BET'"),
        inbox: await orm.em
          .getConnection()
          .execute(
            'select message_id,consumer_name,processed_at is not null as committed from inbox_messages',
          ),
        ledger: await orm.em
          .getConnection()
          .execute(
            'select transaction_id,direction,amount::text,balance_before::text,balance_after::text from wallet_ledger_entries order by created_at,id',
          ),
        outbox: await orm.em
          .getConnection()
          .execute('select id,event_type from outbox_messages order by id'),
      });
      // This is another process/connection: these rows prove an actual committed transaction.
      const committed = await snapshot();
      expect(committed.wallets).toEqual([{ balance: '75.00', version: 2 }]);
      expect(committed.transactions).toHaveLength(1);
      expect(committed.transactions[0]).toMatchObject({ status: 'PROCESSED' });
      expect(committed.inbox).toEqual([
        { message_id: semanticId, consumer_name: consumerName, committed: true },
      ]);
      expect(committed.ledger).toHaveLength(2);
      first.child.kill('SIGKILL');
      const death = await first.exited;
      expect(death.signal).toBe('SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 3200)); // Real SQS visibility expiry, not a mock clock.
      restarted = worker(environment, 'resume');
      const redelivery = await restarted.wait('before-ack');
      expect(redelivery.pid).not.toBe(beforeAck.pid);
      expect(redelivery.brokerMessageId).toBe(sent.MessageId);
      expect(redelivery.receiveCount).toBeGreaterThanOrEqual(2);
      const acknowledged = await restarted.wait('acked');
      expect(acknowledged.brokerMessageId).toBe(sent.MessageId);
      expect(await snapshot()).toEqual(committed);
      expect(
        (await sqs.send(new ReceiveMessageCommand({ QueueUrl: queue, WaitTimeSeconds: 1 })))
          .Messages ?? [],
      ).toHaveLength(0);
      const directory = process.env.TEST_RESULTS_DIR ?? '.test-results';
      await mkdir(directory, { recursive: true });
      const files = [
        'src/infrastructure/workers/wager-transaction.consumer.ts',
        'test/fixtures/inbox-ack-worker.ts',
        'test/integration/inbox-commit-ack.spec.ts',
      ];
      const sourceHashes: Record<string, string> = {};
      for (const file of files)
        sourceHashes[file] = createHash('sha256')
          .update(await readFile(file))
          .digest('hex');
      await writeFile(
        `${directory}/inbox-commit-ack-evidence.json`,
        JSON.stringify(
          {
            baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
            workingTreeDirty:
              execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length >
              0,
            sourceHashes,
            signal: death.signal,
            firstPid: beforeAck.pid,
            restartedPid: redelivery.pid,
            firstReceiveCount: beforeAck.receiveCount,
            redeliveryCount: redelivery.receiveCount,
            wallet: committed.wallets[0],
            betTransactions: committed.transactions.length,
            inbox: committed.inbox.length,
            ledgerEntries: committed.ledger.length,
            acknowledged: true,
            checkedAt: new Date().toISOString(),
          },
          null,
          2,
        ) + '\n',
      );
      console.log(
        '[commit-ack-proof] SIGKILL after PostgreSQL commit; redelivery and ACK confirmed; snapshot unchanged',
      );
    } finally {
      await first?.stop();
      await restarted?.stop();
      if (queue) await sqs.send(new DeleteQueueCommand({ QueueUrl: queue }));
      if (dlq) await sqs.send(new DeleteQueueCommand({ QueueUrl: dlq }));
      sqs.destroy();
      await orm.close(true);
      await admin.query(`drop database "${dbName}"`);
      await admin.end();
    }
  }, 30000);
});

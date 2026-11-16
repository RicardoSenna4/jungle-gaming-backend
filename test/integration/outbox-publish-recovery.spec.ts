import { Client } from 'pg';
import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  SQSClient,
  CreateQueueCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import config from '../../src/infrastructure/database/mikro-orm.config';
import { WalletRepository } from '../../src/application/wallets/wallet-repository';
import { Money } from '../../src/domain/money';
import { worker } from '../helpers/outbox-process';
const suite =
  process.env.RUN_INTEGRATION === '1' && process.env.RUN_SQS_REAL === '1'
    ? describe
    : describe.skip;
suite('Real publisher crash after SQS send before Outbox confirmation', () => {
  it('recovers expired lease with the same eventId, without loss or financial changes', async () => {
    const name = `jungle_outbox_test_${randomUUID().replaceAll('-', '')}`;
    const admin = new Client({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USER ?? 'postgres',
      password: process.env.DB_PASSWORD ?? 'postgres',
      database: process.env.DB_NAME ?? 'jungle',
    });
    await admin.connect();
    await admin.query(`create database "${name}"`);
    const orm = await MikroORM.init({
      ...config,
      dbName: name,
      migrations: { ...config.migrations, snapshot: false },
    });
    const sqs = new SQSClient({
      region: 'us-east-1',
      endpoint: 'http://localhost:4566',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    let queue: string | undefined;
    let first: ReturnType<typeof worker> | undefined;
    let second: ReturnType<typeof worker> | undefined;
    try {
      await orm.getMigrator().up();
      queue = (
        await sqs.send(
          new CreateQueueCommand({
            QueueName: `outbox-${randomUUID()}.fifo`,
            Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
          }),
        )
      ).QueueUrl!;
      await new WalletRepository(orm.em.fork()).create(
        'outbox-proof',
        Money.from({ amount: '100.00', currency: 'BRL' }),
      );
      const financial = async () =>
        JSON.stringify(
          await orm.em
            .getConnection()
            .execute(
              'select (select jsonb_agg(to_jsonb(w)) from wallets w) as wallets,(select jsonb_agg(to_jsonb(l) order by id) from wallet_ledger_entries l) as ledger',
            ),
        );
      const before = await financial();
      const env = {
        ...process.env,
        NODE_ENV: 'test',
        AUTH_MODE: 'challenge',
        DB_HOST: 'localhost',
        DB_NAME: name,
        AWS_ACCESS_KEY_ID: 'test',
        AWS_SECRET_ACCESS_KEY: 'test',
        SQS_ENDPOINT: 'http://localhost:4566',
        SQS_EVENTS_QUEUE_URL: queue,
        OUTBOX_BATCH_SIZE: '1',
        OUTBOX_LEASE_SECONDS: '3',
        OUTBOX_INTERVAL_MS: '100',
      };
      first = worker(env, 'pause');
      const sent = await first.wait('sent');
      const receive = async () =>
        (
          await sqs.send(
            new ReceiveMessageCommand({
              QueueUrl: queue,
              WaitTimeSeconds: 1,
              MaxNumberOfMessages: 1,
            }),
          )
        ).Messages ?? [];
      const delivered = await receive();
      expect(delivered).toHaveLength(1);
      const event = JSON.parse(delivered[0]!.Body!);
      expect(event.eventId).toBeString();
      const pending = await orm.em
        .getConnection()
        .execute('select published_at,attempts from outbox_messages where id = ?', [sent.id]);
      expect(pending).toEqual([{ published_at: null, attempts: 1 }]);
      first.child.kill('SIGKILL');
      expect((await first.exited).signal).toBe('SIGKILL');
      await sqs.send(
        new DeleteMessageCommand({ QueueUrl: queue, ReceiptHandle: delivered[0]!.ReceiptHandle }),
      );
      await new Promise((r) => setTimeout(r, 3200));
      second = worker(env, 'resume');
      await second.wait('marked');
      // FIFO may suppress the retry within its five-minute dedup window. Both sends use eventId.
      let marked = false;
      for (let i = 0; i < 50 && !marked; i++) {
        const rows = await orm.em
          .getConnection()
          .execute(
            'select published_at is not null as marked,attempts,payload from outbox_messages where id = ?',
            [sent.id],
          );
        marked = rows[0].marked;
        if (marked) {
          expect(rows[0].attempts).toBe(2);
          expect(rows[0].payload.eventId).toBe(event.eventId);
        } else await new Promise((r) => setTimeout(r, 50));
      }
      expect(marked).toBe(true);
      expect(await financial()).toBe(before);
      const dir = process.env.TEST_RESULTS_DIR ?? '.test-results';
      await mkdir(dir, { recursive: true });
      await writeFile(
        `${dir}/outbox-publish-recovery-evidence.json`,
        JSON.stringify(
          {
            signal: 'SIGKILL',
            eventId: event.eventId,
            firstPid: sent.pid,
            restartedPid: second.child.pid,
            sqsReceiptConfirmed: true,
            attempts: 2,
            marked,
            financialSnapshotUnchanged: true,
            deliveryGuarantee: 'at-least-once',
          },
          null,
          2,
        ),
      );
    } finally {
      await first?.stop();
      await second?.stop();
      if (queue) await sqs.send(new DeleteQueueCommand({ QueueUrl: queue }));
      sqs.destroy();
      await orm.close(true);
      await admin.query(`drop database "${name}"`);
      await admin.end();
    }
  }, 30000);
});

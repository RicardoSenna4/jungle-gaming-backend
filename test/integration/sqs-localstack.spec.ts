import { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import mikroOrmConfig from '../../src/infrastructure/database/mikro-orm.config';
import { Money } from '../../src/domain/money';
import { WalletRepository } from '../../src/application/wallets/wallet-repository';
import { WagerTransactionConsumer } from '../../src/infrastructure/workers/wager-transaction.consumer';
import {
  InboxOrmEntity,
  LedgerOrmEntity,
  OutboxOrmEntity,
  WagerTransactionOrmEntity,
} from '../../src/infrastructure/database/mikro-orm/entities';
import { WagerProcessingService } from '../../src/application/wager-processing.service';
import { OutboxPublisherWorker } from '../../src/infrastructure/workers/outbox-publisher.worker';
import { SqsInfrastructureClient } from '../../src/infrastructure/workers/sqs-infrastructure.client';
import { MetricsService } from '../../src/infrastructure/telemetry/metrics.service';

const describeSqs = process.env.RUN_SQS_REAL === '1' ? describe : describe.skip;

describeSqs('LocalStack SQS FIFO end-to-end', () => {
  let orm: MikroORM;
  let em: ReturnType<MikroORM['em']['fork']>;
  let sqs: SQSClient;
  const queueUrl =
    process.env.SQS_QUEUE_URL ?? 'http://localhost:4566/000000000000/wager-transactions.fifo';

  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);
    await orm.getMigrator().up();
    em = orm.em.fork();
    sqs = new SQSClient({
      region: 'us-east-1',
      endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
  });

  afterEach(async () => {
    await em
      .getConnection()
      .execute(
        'truncate table outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets cascade',
      );
  });

  afterAll(async () => {
    sqs.destroy();
    await orm.close(true);
  });

  it('publishes committed outbox events to real SQS and marks them as published', async () => {
    const wallet = await new WalletRepository(em).create('outbox-real-player',
      Money.from({ amount: '10.00', currency: 'BRL' }));
    const producer = new SqsInfrastructureClient();
    const publisher = new OutboxPublisherWorker(em.fork(), producer, new MetricsService());
    try {
      const result = await publisher.runOnce();
      expect(result).toMatchObject({ claimed: 2, published: 2, failed: 0 });
      em.clear();
      const rows = await em.find(OutboxOrmEntity, {});
      expect(rows).toHaveLength(2);
      expect(rows.every(row => !!row.publishedAt)).toBe(true);
      const eventsQueueUrl = 'http://localhost:4566/000000000000/wager-events.fifo';
      const received = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: eventsQueueUrl, WaitTimeSeconds: 1, MaxNumberOfMessages: 10,
      }));
      expect((received.Messages ?? []).length).toBeGreaterThan(0);
      for (const message of received.Messages ?? []) {
        const payload = JSON.parse(message.Body ?? '{}');
        expect(typeof payload.eventId).toBe('string');
        expect(payload.version).toBe(1);
        if (message.ReceiptHandle) await sqs.send(new DeleteMessageCommand({
          QueueUrl: eventsQueueUrl, ReceiptHandle: message.ReceiptHandle,
        }));
      }
      expect(wallet.version).toBe(1);
    } finally {
      producer.onModuleDestroy();
    }
  });

  it('delivers one FIFO message and deletes it only after the SQL commit', async () => {
    const wallet = await new WalletRepository(em).create(
      'localstack-player',
      Money.from({ amount: '20.00', currency: 'BRL' }),
    );
    const messageId = `localstack-${Date.now()}`;
    const consumer = new WagerTransactionConsumer(new WagerProcessingService(em));
    const body = {
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-localstack',
        externalTransactionId: messageId,
        idempotencyKey: messageId,
        playerId: 'localstack-player',
        walletId: wallet.id,
        roundId: 'localstack-round',
        gameId: 'localstack-game',
        kind: 'BET',
        money: { amount: '5.00', currency: 'BRL' },
      },
    };
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(body),
        MessageGroupId: 'localstack-player',
        MessageDeduplicationId: messageId,
      }),
    );

    consumer.start();
    const deadline = Date.now() + 5_000;
    while (
      Date.now() < deadline &&
      (await em.count(WagerTransactionOrmEntity, { externalTransactionId: messageId })) === 0
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await consumer.stop();

    const wager = await em.findOneOrFail(WagerTransactionOrmEntity, {
      externalTransactionId: messageId,
    });
    expect(await em.count(WagerTransactionOrmEntity, { externalTransactionId: messageId })).toBe(1);
    expect(
      await em.count(InboxOrmEntity, { messageId, consumerName: 'wager-transaction-consumer-v1' }),
    ).toBe(1);
    expect(await em.count(LedgerOrmEntity, { walletId: wallet.id, direction: 'DEBIT' })).toBe(1);
    expect(await em.count(OutboxOrmEntity, { aggregateId: wager.id })).toBe(2);
    const afterAck = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: 1 }),
    );
    expect(afterAck.Messages ?? []).toHaveLength(0);
  });
});

import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
} from '@aws-sdk/client-sqs';
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
import {
  FinancialProcessingError,
  WagerProcessingService,
} from '../../src/application/wager-processing.service';
import { QuarantineOrmEntity } from '../../src/infrastructure/database/mikro-orm/quarantine.entity';
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
        'truncate table message_quarantine, outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets cascade',
      );
  });

  afterAll(async () => {
    sqs.destroy();
    await orm.close(true);
  });

  it('publishes committed outbox events to real SQS and marks them as published', async () => {
    const wallet = await new WalletRepository(em).create(
      'outbox-real-player',
      Money.from({ amount: '10.00', currency: 'BRL' }),
    );
    const producer = new SqsInfrastructureClient();
    const publisher = new OutboxPublisherWorker(em.fork(), producer, new MetricsService());
    try {
      const result = await publisher.runOnce();
      expect(result).toMatchObject({ claimed: 2, published: 2, failed: 0 });
      em.clear();
      const rows = await em.find(OutboxOrmEntity, {});
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => !!row.publishedAt)).toBe(true);
      const eventsQueueUrl = 'http://localhost:4566/000000000000/wager-events.fifo';
      const received = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: eventsQueueUrl,
          WaitTimeSeconds: 1,
          MaxNumberOfMessages: 10,
        }),
      );
      expect((received.Messages ?? []).length).toBeGreaterThan(0);
      for (const message of received.Messages ?? []) {
        const payload = JSON.parse(message.Body ?? '{}');
        expect(typeof payload.eventId).toBe('string');
        expect(payload.version).toBe(1);
        if (message.ReceiptHandle)
          await sqs.send(
            new DeleteMessageCommand({
              QueueUrl: eventsQueueUrl,
              ReceiptHandle: message.ReceiptHandle,
            }),
          );
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
  it('survives a post-commit, pre-ACK redelivery over real SQS without another debit', async () => {
    const wallet = await new WalletRepository(em).create(
      'redelivery-player',
      Money.from({ amount: '20.00', currency: 'BRL' }),
    );
    const messageId = 'redelivery-' + Date.now();
    const body = {
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'redelivery-provider',
        externalTransactionId: messageId,
        idempotencyKey: messageId,
        playerId: 'redelivery-player',
        walletId: wallet.id,
        roundId: 'round',
        gameId: 'game',
        kind: 'BET',
        money: { amount: '5.00', currency: 'BRL' },
      },
    };
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(body),
        MessageGroupId: 'redelivery-player',
        MessageDeduplicationId: messageId,
      }),
    );
    const received = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: 2, VisibilityTimeout: 15 }),
    );
    const message = received.Messages?.[0];
    expect(message?.ReceiptHandle).toBeTruthy();
    const consumer = new WagerTransactionConsumer(new WagerProcessingService(em));
    try {
      const committed = await consumer.handleMessage(message!);
      expect(committed).toMatchObject({ acknowledged: true, status: 'PROCESSED' });
      // Simulate abrupt death after commit and before DeleteMessage.
      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: message!.ReceiptHandle,
          VisibilityTimeout: 0,
        }),
      );
      const retry = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: 2 }),
      );
      const redelivered = retry.Messages?.[0];
      expect(redelivered?.ReceiptHandle).toBeTruthy();
      expect(await consumer.handleMessage(redelivered!)).toMatchObject({ acknowledged: true });
      await sqs.send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: redelivered!.ReceiptHandle,
        }),
      );
      expect(await em.count(InboxOrmEntity, { messageId })).toBe(1);
      expect(await em.count(WagerTransactionOrmEntity, { externalTransactionId: messageId })).toBe(
        1,
      );
      expect(await em.count(LedgerOrmEntity, { walletId: wallet.id, direction: 'DEBIT' })).toBe(1);
    } finally {
      await consumer.onModuleDestroy();
    }
  });

  it('persists malformed messages in quarantine before ACK without DLQ redrive', async () => {
    const messageId = 'invalid-' + Date.now();
    const rawPayload = JSON.stringify({
      messageId,
      type: 'INVALID',
      occurredAt: new Date().toISOString(),
    });
    const sent = await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: rawPayload,
        MessageGroupId: 'quarantine-group',
        MessageDeduplicationId: messageId,
      }),
    );
    expect(sent.MessageId).toBeTruthy();
    const consumer = new WagerTransactionConsumer(new WagerProcessingService(em));
    try {
      consumer.start();
      const deadline = Date.now() + 10_000;
      while (
        Date.now() < deadline &&
        (await em.count(QuarantineOrmEntity, {
          consumerName: 'wager-transaction-consumer-v1',
          messageId: sent.MessageId!,
        })) === 0
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await consumer.stop();
      em.clear();

      const quarantined = await em.findOneOrFail(QuarantineOrmEntity, {
        consumerName: 'wager-transaction-consumer-v1',
        messageId: sent.MessageId!,
      });
      expect(quarantined.reason).toBe('INVALID_MESSAGE');
      expect(quarantined.status).toBe('OPEN');
      expect(quarantined.rawPayload).toBe(rawPayload);
      expect(await em.count(InboxOrmEntity)).toBe(0);
      expect(await em.count(WagerTransactionOrmEntity)).toBe(0);
      expect(await em.count(LedgerOrmEntity)).toBe(0);

      const remaining = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: 1 }),
      );
      expect(remaining.Messages ?? []).toHaveLength(0);
      const dlq = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: 'http://localhost:4566/000000000000/wager-transactions-dlq.fifo',
          WaitTimeSeconds: 1,
        }),
      );
      expect((dlq.Messages ?? []).some((message) => message.Body === rawPayload)).toBe(false);
    } finally {
      await consumer.onModuleDestroy();
    }
  });

  it('redrives retryable processing failures to the real LocalStack DLQ without quarantine', async () => {
    const previous = process.env.SQS_VISIBILITY_TIMEOUT;
    process.env.SQS_VISIBILITY_TIMEOUT = '1';
    const messageId = 'retryable-' + Date.now();
    const dlqUrl = 'http://localhost:4566/000000000000/wager-transactions-dlq.fifo';
    const payload = JSON.stringify({
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'retryable-provider',
        externalTransactionId: messageId,
        idempotencyKey: messageId,
        playerId: 'retryable-player',
        walletId: '11111111-1111-4111-8111-111111111111',
        roundId: 'retryable-round',
        gameId: 'retryable-game',
        kind: 'BET',
        money: { amount: '5.00', currency: 'BRL' },
      },
    });
    let attempts = 0;
    const unavailableService = {
      process: async () => {
        attempts += 1;
        throw new FinancialProcessingError('DATABASE_UNAVAILABLE', 503);
      },
    } as unknown as WagerProcessingService;
    const consumer = new WagerTransactionConsumer(unavailableService);
    let redriven = false;
    try {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: payload,
          MessageGroupId: 'retryable-group',
          MessageDeduplicationId: messageId,
        }),
      );
      consumer.start();
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline && !redriven) {
        const received = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: dlqUrl,
            WaitTimeSeconds: 1,
            MaxNumberOfMessages: 10,
          }),
        );
        for (const message of received.Messages ?? []) {
          if (message.Body !== payload) continue;
          redriven = true;
          if (message.ReceiptHandle)
            await sqs.send(
              new DeleteMessageCommand({
                QueueUrl: dlqUrl,
                ReceiptHandle: message.ReceiptHandle,
              }),
            );
        }
      }
      expect(redriven).toBe(true);
      expect(attempts).toBeGreaterThanOrEqual(3);
      expect(await em.count(QuarantineOrmEntity)).toBe(0);
      expect(await em.count(InboxOrmEntity)).toBe(0);
      expect(await em.count(WagerTransactionOrmEntity)).toBe(0);
      expect(await em.count(LedgerOrmEntity)).toBe(0);
    } finally {
      await consumer.onModuleDestroy();
      if (previous === undefined) delete process.env.SQS_VISIBILITY_TIMEOUT;
      else process.env.SQS_VISIBILITY_TIMEOUT = previous;
    }
  });

});

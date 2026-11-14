import { MikroORM } from '@mikro-orm/postgresql';
import mikroOrmConfig from '../../src/infrastructure/database/mikro-orm.config';
import { WalletRepository } from '../../src/application/wallets/wallet-repository';
import { Money } from '../../src/domain/money';
import { WagerKind } from '../../src/domain/wager-transaction';
import { WagerProcessingService } from '../../src/application/wager-processing.service';
import { WagerTransactionConsumer } from '../../src/infrastructure/workers/wager-transaction.consumer';
import {
  InboxOrmEntity,
  LedgerOrmEntity,
  OutboxOrmEntity,
  WagerTransactionOrmEntity,
} from '../../src/infrastructure/database/mikro-orm/entities';

const describeIntegration = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;

describeIntegration('SQS consumer with transactional inbox', () => {
  let orm: MikroORM;
  let em: ReturnType<MikroORM['em']['fork']>;
  let consumer: WagerTransactionConsumer;

  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);
    await orm.getMigrator().up();
  });

  beforeEach(() => {
    em = orm.em.fork();
    consumer = new WagerTransactionConsumer(new WagerProcessingService(em));
  });

  afterEach(async () => {
    await em
      .getConnection()
      .execute(
        'truncate table outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets cascade',
      );
  });

  afterAll(async () => orm.close(true));

  function message(messageId: string, walletId: string, idempotencyKey: string) {
    return {
      MessageId: messageId,
      ReceiptHandle: `receipt-${messageId}`,
      Body: JSON.stringify({
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: {
          providerId: 'provider-sqs',
          externalTransactionId: `external-${messageId}`,
          idempotencyKey,
          playerId: 'sqs-player',
          walletId,
          roundId: 'sqs-round',
          gameId: 'sqs-game',
          kind: WagerKind.BET,
          money: { amount: '10.00', currency: 'BRL' },
        },
      }),
    };
  }

  it('processes a message and safely handles redelivery after commit', async () => {
    const wallet = await new WalletRepository(em).create(
      'sqs-player',
      Money.from({ amount: '100.00', currency: 'BRL' }),
    );
    const first = await consumer.handleMessage(message('message-1', wallet.id, 'sqs-key-1'));
    const redelivery = await consumer.handleMessage(message('message-1', wallet.id, 'sqs-key-1'));

    expect(first).toMatchObject({ acknowledged: true, status: 'PROCESSED' });
    expect(redelivery).toMatchObject({ acknowledged: true, status: 'PROCESSED' });
    expect(await em.count(InboxOrmEntity, { consumerName: 'wager-transaction-consumer-v1' })).toBe(
      1,
    );
    expect(await em.count(WagerTransactionOrmEntity, { kind: WagerKind.BET })).toBe(1);
    expect(await em.count(LedgerOrmEntity, { direction: 'DEBIT' })).toBe(1);
    expect(await em.count(OutboxOrmEntity, { eventType: 'WagerTransactionProcessed' })).toBe(1);
  });

  it('acknowledges malformed messages without creating financial records', async () => {
    const result = await consumer.handleMessage({ Body: JSON.stringify({ type: 'wrong' }) });
    expect(result).toMatchObject({ acknowledged: false, failureCode: 'INVALID_MESSAGE' });
    expect(await em.count(InboxOrmEntity)).toBe(0);
    expect(await em.count(WagerTransactionOrmEntity)).toBe(0);
  });

  it('rejects a provider outside the configured identity allowlist', async () => {
    const original = process.env.ALLOWED_PROVIDER_IDS;
    process.env.ALLOWED_PROVIDER_IDS = 'provider-allowed';
    try {
      const result = await consumer.handleMessage({
        Body: JSON.stringify({
          messageId: 'message-provider',
          type: 'WagerTransactionRequested',
          data: {
            providerId: 'provider-sqs',
            idempotencyKey: 'key-provider',
          },
        }),
      });
      expect(result).toMatchObject({ acknowledged: false, failureCode: 'INVALID_MESSAGE' });
      expect(await em.count(InboxOrmEntity)).toBe(0);
    } finally {
      if (original === undefined) delete process.env.ALLOWED_PROVIDER_IDS;
      else process.env.ALLOWED_PROVIDER_IDS = original;
    }
  });
});

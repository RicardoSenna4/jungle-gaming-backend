import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import mikroOrmConfig from '../../src/infrastructure/database/mikro-orm.config';
import { Money } from '../../src/domain/money';
import { WalletRepository } from '../../src/application/wallets/wallet-repository';
import { WagerTransactionConsumer } from '../../src/infrastructure/workers/wager-transaction.consumer';
import { WagerTransactionOrmEntity } from '../../src/infrastructure/database/mikro-orm/entities';
import { WagerProcessingService } from '../../src/application/wager-processing.service';

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

    expect(await em.count(WagerTransactionOrmEntity, { externalTransactionId: messageId })).toBe(1);
  });
});

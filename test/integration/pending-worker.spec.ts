import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import mikroOrmConfig from '../../src/infrastructure/database/mikro-orm.config';
import { AppModule } from '../../src/app.module';
import { PendingReferenceWorker } from '../../src/infrastructure/workers/pending-reference.worker';
import { WagerProcessingService } from '../../src/application/wager-processing.service';
import { WalletRepository } from '../../src/application/wallets/wallet-repository';
import { Money } from '../../src/domain/money';
import {
  LedgerOrmEntity,
  WagerTransactionOrmEntity,
} from '../../src/infrastructure/database/mikro-orm/entities';

const describeIntegration = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;
describeIntegration('NestJS scheduled pending-reference worker', () => {
  let orm: MikroORM;
  let app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>>;
  let worker: PendingReferenceWorker;
  const oldEnabled = process.env.ENABLE_PENDING_REFERENCE_WORKER;
  const oldInterval = process.env.PENDING_REFERENCE_INTERVAL_MS;

  beforeAll(async () => {
    process.env.ENABLE_PENDING_REFERENCE_WORKER = 'false';
    process.env.PENDING_REFERENCE_INTERVAL_MS = '100';
    orm = await MikroORM.init(mikroOrmConfig);
    await orm.getMigrator().up();
    app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    worker = app.get(PendingReferenceWorker);
  });
  afterAll(async () => {
    await app.close();
    await orm.close(true);
    if (oldEnabled === undefined) delete process.env.ENABLE_PENDING_REFERENCE_WORKER;
    else process.env.ENABLE_PENDING_REFERENCE_WORKER = oldEnabled;
    if (oldInterval === undefined) delete process.env.PENDING_REFERENCE_INTERVAL_MS;
    else process.env.PENDING_REFERENCE_INTERVAL_MS = oldInterval;
  });
  afterEach(async () => {
    worker.stop();
    await orm.em
      .fork()
      .getConnection()
      .execute(
        'truncate table inbox_messages, outbox_messages, wallet_ledger_entries, wager_transactions, wallets cascade',
      );
  });

  it('automatically resolves a REFUND after its BET arrives, without a direct runOnce call', async () => {
    const em = orm.em.fork();
    const service = app.get(WagerProcessingService);
    const wallet = await new WalletRepository(em).create(
      'scheduled-player',
      Money.from({ amount: '10.00', currency: 'BRL' }),
    );
    const refundInput = {
      providerId: 'scheduled-provider',
      externalTransactionId: 'refund-before',
      playerId: 'scheduled-player',
      walletId: wallet.id,
      roundId: 'scheduled-round',
      gameId: 'game-1',
      kind: 'REFUND' as const,
      money: { amount: '10.00', currency: 'BRL' },
      referenceExternalTransactionId: 'bet-later',
    };
    const pending = await service.process('scheduled-refund-key', refundInput);
    expect(pending.status).toBe('PENDING_REFERENCE');
    await service.process('scheduled-bet-key', {
      ...refundInput,
      kind: 'BET',
      externalTransactionId: 'bet-later',
      referenceExternalTransactionId: undefined,
    });
    worker.start();
    const deadline = Date.now() + 5_000;
    let status: string | undefined;
    while (Date.now() < deadline) {
      status = (await em.fork().findOne(WagerTransactionOrmEntity, { id: pending.transactionId }))
        ?.status;
      if (status === 'PROCESSED') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(status).toBe('PROCESSED');
    expect(
      await em.fork().count(LedgerOrmEntity, { walletId: wallet.id, direction: 'CREDIT' }),
    ).toBe(2);
    worker.stop();
  });
});

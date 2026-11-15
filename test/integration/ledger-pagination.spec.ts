import { MikroORM } from '@mikro-orm/postgresql';
import mikroOrmConfig from '../../src/infrastructure/database/mikro-orm.config';
import { WalletRepository } from '../../src/application/wallets/wallet-repository';
import { WagerProcessingService } from '../../src/application/wager-processing.service';
import { WagerKind } from '../../src/domain/wager-transaction';
import { Money } from '../../src/domain/money';

const describeIntegration = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;
describeIntegration('ledger cursor stability against PostgreSQL', () => {
  let orm: MikroORM;
  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);
    await orm.getMigrator().up();
  });
  afterEach(async () => {
    await orm.em
      .fork()
      .getConnection()
      .execute(
        'truncate table inbox_messages, outbox_messages, wallet_ledger_entries, wager_transactions, wallets cascade',
      );
  });
  afterAll(async () => orm.close(true));

  it('pages every ledger entry once using a microsecond-precision cursor', async () => {
    const em = orm.em.fork();
    const repo = new WalletRepository(em);
    const wallet = await repo.create(
      'cursor-player',
      Money.from({ amount: '20.00', currency: 'BRL' }),
    );
    const service = new WagerProcessingService(em);
    for (let i = 0; i < 12; i++) {
      const result = await service.process('cursor-key-' + i, {
        providerId: 'cursor-provider',
        externalTransactionId: 'cursor-tx-' + i,
        playerId: 'cursor-player',
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerKind.BET,
        money: { amount: '1.00', currency: 'BRL' },
      });
      expect(result.status).toBe('PROCESSED');
    }
    let cursor: string | undefined;
    const ids: string[] = [];
    for (let pageNum = 0; pageNum < 10; pageNum++) {
      const page = await repo.findLedger(wallet.id, 3, cursor);
      ids.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(ids).toHaveLength(13);
    expect(new Set(ids).size).toBe(13);
    const [reconciliation] = await em
      .getConnection()
      .execute<Array<{ balance: string }>>(
        'select balance::text as balance from wallets where id = ?',
        [wallet.id],
      );
    expect(reconciliation?.balance).toBe('8.00');
  });
});

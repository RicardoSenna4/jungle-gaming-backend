import { MikroORM } from '@mikro-orm/postgresql';
import mikroOrmConfig from '../../src/infrastructure/database/mikro-orm.config';
import { WalletRepository } from '../../src/application/wallets/wallet-repository';
import { Money } from '../../src/domain/money';
import {
  WagerTransactionOrmEntity,
  LedgerOrmEntity,
  WalletOrmEntity,
} from '../../src/infrastructure/database/mikro-orm/entities';

const describeIntegration = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;

describeIntegration('wallet persistence with PostgreSQL', () => {
  let orm: MikroORM;
  let em: ReturnType<MikroORM['em']['fork']>;
  let repository: WalletRepository;

  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);
    await orm.getMigrator().up();
  });

  beforeEach(() => {
    em = orm.em.fork();
    repository = new WalletRepository(em);
  });

  afterEach(async () => {
    await em
      .getConnection()
      .execute(
        'truncate table outbox_messages, wallet_ledger_entries, wager_transactions, wallets cascade',
      );
  });

  afterAll(async () => {
    await orm.close(true);
  });

  it('creates a zero wallet at version one without opening movement', async () => {
    const result = await repository.create('player-zero', Money.zero('BRL'));
    expect(result.version).toBe(1);
    expect(result.balance).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(await em.count(WagerTransactionOrmEntity)).toBe(0);
    expect(await em.count(LedgerOrmEntity)).toBe(0);
  });

  it('creates positive opening transaction and credit ledger in one transaction', async () => {
    const result = await repository.create(
      'player-opening',
      Money.from({ amount: '100.10', currency: 'BRL' }),
    );
    expect(result.version).toBe(1);
    expect(
      await em.count(WagerTransactionOrmEntity, { kind: 'OPENING', status: 'PROCESSED' }),
    ).toBe(1);
    expect(await em.count(LedgerOrmEntity, { direction: 'CREDIT', amount: '100.10' })).toBe(1);
  });

  it('rejects duplicate player and currency while allowing another currency', async () => {
    await repository.create('player-unique', Money.zero('BRL'));
    await expect(repository.create('player-unique', Money.zero('BRL'))).rejects.toThrow(
      'WALLET_ALREADY_EXISTS',
    );
    await expect(repository.create('player-unique', Money.zero('USD'))).resolves.toMatchObject({
      version: 1,
    });
  });

  it('rolls back wallet and opening records when the SQL transaction fails', async () => {
    await expect(
      em.transactional(async (transactionEm) => {
        transactionEm.create(WalletOrmEntity, {
          id: '00000000-0000-0000-0000-000000000011',
          playerId: 'player-rollback',
          currency: 'BRL',
          balance: '10.00',
          version: 1,
        });
        await transactionEm.flush();
        throw new Error('ROLLBACK_PROBE');
      }),
    ).rejects.toThrow('ROLLBACK_PROBE');
    expect(await em.count(WalletOrmEntity, { playerId: 'player-rollback' })).toBe(0);
  });

  it('rejects direct ledger update and delete through database trigger', async () => {
    const result = await repository.create(
      'player-ledger',
      Money.from({ amount: '1.00', currency: 'BRL' }),
    );
    const ledger = await em.findOneOrFail(LedgerOrmEntity, { walletId: result.id });
    await expect(
      em
        .getConnection()
        .execute('update wallet_ledger_entries set amount = ? where id = ?', ['2.00', ledger.id]),
    ).rejects.toThrow('ledger is append-only');
    await expect(
      em.getConnection().execute('delete from wallet_ledger_entries where id = ?', [ledger.id]),
    ).rejects.toThrow('ledger is append-only');
  });
});

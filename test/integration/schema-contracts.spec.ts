import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import mikroOrmConfig from '../../src/infrastructure/database/mikro-orm.config';
import { WalletRepository } from '../../src/application/wallets/wallet-repository';
import { Money } from '../../src/domain/money';

const describeIntegration = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;
describeIntegration('PostgreSQL schema constraints', () => {
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
        'truncate table message_quarantine, inbox_messages, outbox_messages, wallet_ledger_entries, wager_transactions, wallets cascade',
      );
  });
  afterAll(async () => orm.close(true));

  it('refuses negative wallet balances and invalid versions at the database boundary', async () => {
    const em = orm.em.fork();
    const wallet = await new WalletRepository(em).create('schema-player', Money.zero('BRL'));
    await expect(
      em.getConnection().execute('update wallets set balance = -0.01 where id = ?', [wallet.id]),
    ).rejects.toThrow();
    await expect(
      em.getConnection().execute('update wallets set version = 0 where id = ?', [wallet.id]),
    ).rejects.toThrow();
    const rows = await em
      .getConnection()
      .execute<Array<{ balance: string; version: number }>>(
        'select balance::text as balance, version from wallets where id = ?',
        [wallet.id],
      );
    expect(rows[0]).toMatchObject({ balance: '0.00', version: 1 });
  });

  it('rejects zero-value transactions and protects ledger arithmetic', async () => {
    const em = orm.em.fork();
    const wallet = await new WalletRepository(em).create('schema-ledger', Money.zero('BRL'));
    const txId = randomUUID();
    const sql = `insert into wager_transactions
      (id,provider_id,external_transaction_id,idempotency_key,payload_hash,
       wallet_id,player_id,round_id,game_id,kind,amount,currency,status)
      values (?,'schema-provider',?,?,?,?,'schema-ledger','round','game','BET',?,'BRL','PENDING')`;
    await expect(
      em
        .getConnection()
        .execute(sql, [txId, 'zero', 'zero-key', '0'.repeat(64), wallet.id, '0.00']),
    ).rejects.toThrow();
    await em
      .getConnection()
      .execute(sql, [txId, 'valid', 'valid-key', '0'.repeat(64), wallet.id, '1.00']);
    const malformed = `insert into wallet_ledger_entries
      (id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after)
      values (?,?,?,'DEBIT',1.00,'BRL',0.00,1.00)`;
    await expect(
      em.getConnection().execute(malformed, [randomUUID(), wallet.id, txId]),
    ).rejects.toThrow();
    expect(
      (
        await em
          .getConnection()
          .execute<Array<{ n: string }>>(
            'select count(*)::text as n from wallet_ledger_entries where transaction_id = ?',
            [txId],
          )
      )[0]?.n,
    ).toBe('0');
  });

  it('rejects a value exceeding NUMERIC(20,2) instead of silently rounding', async () => {
    const em = orm.em.fork();
    const wallet = await new WalletRepository(em).create('schema-overflow', Money.zero('BRL'));
    await expect(
      em
        .getConnection()
        .execute('update wallets set balance = ? where id = ?', [
          '1000000000000000000.00',
          wallet.id,
        ]),
    ).rejects.toThrow();
  });
});

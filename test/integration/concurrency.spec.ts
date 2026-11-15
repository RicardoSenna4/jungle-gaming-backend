import { MikroORM } from '@mikro-orm/postgresql';
import mikroOrmConfig from '../../src/infrastructure/database/mikro-orm.config';
import { WalletRepository } from '../../src/application/wallets/wallet-repository';
import { Money } from '../../src/domain/money';
import {
  LedgerOrmEntity,
  WagerTransactionOrmEntity,
  WalletOrmEntity,
} from '../../src/infrastructure/database/mikro-orm/entities';

const describeIntegration = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;
type WorkerResult = {
  transactionId?: string;
  status?: string;
  idempotentReplay?: boolean;
  error?: string;
};

async function runProcess(
  keyPrefix: string,
  input: Record<string, unknown>,
  count = 1,
): Promise<WorkerResult[]> {
  const child = Bun.spawn(
    [
      'bun',
      'test/integration/concurrency-worker.ts',
      keyPrefix,
      JSON.stringify(input),
      String(count),
    ],
    { stdout: 'pipe', stderr: 'pipe', env: process.env },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`worker exited ${exitCode}: ${stderr}`);
  return JSON.parse(stdout) as WorkerResult[];
}

describeIntegration('real multi-process wallet concurrency', () => {
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

  afterAll(async () => orm.close(true));

  function bet(walletId: string, externalTransactionId: string, amount: string, playerId: string) {
    return {
      providerId: 'concurrency-provider',
      externalTransactionId,
      playerId,
      walletId,
      roundId: 'concurrency-round',
      gameId: 'concurrency-game',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    };
  }

  it('A: serializes two simultaneous 80.00 BETs on one wallet', async () => {
    const wallet = await repository.create(
      'player-a',
      Money.from({ amount: '100.00', currency: 'BRL' }),
    );
    const results = (
      await Promise.all([
        runProcess('a-one', bet(wallet.id, 'bet-a-1', '80.00', 'player-a')),
        runProcess('a-two', bet(wallet.id, 'bet-a-2', '80.00', 'player-a')),
      ])
    ).flat();

    expect(results.filter((result) => result.status === 'PROCESSED')).toHaveLength(1);
    expect(
      results.filter((result) => result.error === undefined && result.status === 'REJECTED'),
    ).toHaveLength(1);
    expect(await em.count(LedgerOrmEntity, { walletId: wallet.id, direction: 'DEBIT' })).toBe(1);
    em.clear();
    expect(await em.findOneOrFail(WalletOrmEntity, { id: wallet.id })).toMatchObject({
      balance: '20.00',
      version: 2,
    });
    const bets = await em.find(WagerTransactionOrmEntity, { walletId: wallet.id, kind: 'BET' });
    expect(bets).toHaveLength(2);
    expect(
      bets.filter(
        (item) => item.status === 'REJECTED' && item.failureCode === 'INSUFFICIENT_FUNDS',
      ),
    ).toHaveLength(1);
  });

  it('B: handles 50 parallel submissions of the same key with one financial effect', async () => {
    const wallet = await repository.create(
      'player-b',
      Money.from({ amount: '100.00', currency: 'BRL' }),
    );
    const input = bet(wallet.id, 'bet-b', '80.00', 'player-b');
    const batches = await Promise.all(
      Array.from({ length: 10 }, () => runProcess('__same__', input, 5)),
    );
    const results = batches.flat();

    expect(results).toHaveLength(50);
    if (results.some((result) => result.error)) {
      console.error(
        'Concurrent idempotency errors:',
        JSON.stringify(results.filter((r) => r.error)),
      );
    }
    expect(results.filter((result) => result.error)).toHaveLength(0);
    expect(results.filter((result) => result.idempotentReplay === false)).toHaveLength(1);
    expect(results.filter((result) => result.idempotentReplay === true)).toHaveLength(49);
    const conflict = await runProcess('__same__', {
      ...input,
      money: { amount: '70.00', currency: 'BRL' },
    });
    expect(conflict[0]?.error).toBe('IDEMPOTENCY_PAYLOAD_CONFLICT');
    expect(await em.count(WagerTransactionOrmEntity, { walletId: wallet.id, kind: 'BET' })).toBe(1);
    expect(await em.count(LedgerOrmEntity, { walletId: wallet.id, direction: 'DEBIT' })).toBe(1);
    em.clear();
    expect(await em.findOneOrFail(WalletOrmEntity, { id: wallet.id })).toMatchObject({
      balance: '20.00',
    });
  });

  it('C: processes different wallets in parallel without a global lock', async () => {
    const wallets = await Promise.all(
      ['c-1', 'c-2', 'c-3'].map((playerId) =>
        repository.create(playerId, Money.from({ amount: '100.00', currency: 'BRL' })),
      ),
    );
    const results = (
      await Promise.all(
        wallets.map((wallet, index) =>
          runProcess(`c-${index}`, bet(wallet.id, `bet-c-${index}`, '10.00', `c-${index + 1}`)),
        ),
      )
    ).flat();

    expect(results).toHaveLength(3);
    expect(results.every((result) => result.status === 'PROCESSED')).toBe(true);
    expect(await em.count(LedgerOrmEntity, { direction: 'DEBIT' })).toBe(3);
    expect(await em.count(WagerTransactionOrmEntity, { kind: 'BET', status: 'PROCESSED' })).toBe(3);
  });

  it('D: maintains consistency with three independent application processes', async () => {
    const wallet = await repository.create(
      'player-d',
      Money.from({ amount: '100.00', currency: 'BRL' }),
    );
    const results = (
      await Promise.all(
        ['d-1', 'd-2', 'd-3'].map((key, index) =>
          runProcess(key, bet(wallet.id, `bet-d-${index}`, '10.00', 'player-d')),
        ),
      )
    ).flat();

    expect(results).toHaveLength(3);
    expect(results.every((result) => result.status === 'PROCESSED')).toBe(true);
    expect(await em.count(LedgerOrmEntity, { walletId: wallet.id, direction: 'DEBIT' })).toBe(3);
    em.clear();
    expect(await em.findOneOrFail(WalletOrmEntity, { id: wallet.id })).toMatchObject({
      balance: '70.00',
      version: 4,
    });
    const walletRow = await em.findOneOrFail(WalletOrmEntity, { id: wallet.id });
    const [reconciliation] = await em.getConnection().execute<{ reconstructed_balance: string }[]>(
      `select coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0)::text as reconstructed_balance
       from wallet_ledger_entries where wallet_id = ?`,
      [wallet.id],
    );
    expect(reconciliation?.reconstructed_balance).toBe(walletRow.balance);
  });
});

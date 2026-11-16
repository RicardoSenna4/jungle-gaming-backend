import { MikroORM } from '@mikro-orm/postgresql';
import mikroOrmConfig from '../../src/infrastructure/database/mikro-orm.config';
import {
  WagerProcessingService,
  SubmitInput,
} from '../../src/application/wager-processing.service';
import { WalletRepository } from '../../src/application/wallets/wallet-repository';
import { Money } from '../../src/domain/money';
import {
  LedgerOrmEntity,
  OutboxOrmEntity,
  WagerTransactionOrmEntity,
  WalletOrmEntity,
} from '../../src/infrastructure/database/mikro-orm/entities';

const describeIntegration = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;

describeIntegration('financial processing with PostgreSQL', () => {
  let orm: MikroORM;
  let em: ReturnType<MikroORM['em']['fork']>;
  let service: WagerProcessingService;
  let walletRepository: WalletRepository;

  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);
    await orm.getMigrator().up();
  });

  beforeEach(() => {
    em = orm.em.fork();
    service = new WagerProcessingService(em);
    walletRepository = new WalletRepository(em);
  });

  afterEach(async () => {
    await em
      .getConnection()
      .execute(
        'truncate table message_quarantine, outbox_messages, wallet_ledger_entries, wager_transactions, wallets cascade',
      );
  });

  afterAll(async () => orm.close(true));

  function input(
    walletId: string,
    kind: 'BET' | 'WIN' | 'LOSS',
    amount = '20.00',
    playerId = 'player-1',
  ): SubmitInput {
    return {
      providerId: 'provider-a',
      externalTransactionId: `external-${kind.toLowerCase()}`,
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind,
      money: { amount, currency: 'BRL' },
    };
  }

  it('processes BET, replays its original balance, then processes WIN', async () => {
    const wallet = await walletRepository.create(
      'player-1',
      Money.from({ amount: '100.00', currency: 'BRL' }),
    );
    const bet = await service.process('key-bet', input(wallet.id, 'BET'));
    expect(bet).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '80.00' },
      idempotentReplay: false,
    });

    const win = await service.process('key-win', input(wallet.id, 'WIN', '10.00'));
    expect(win.balance.amount).toBe('90.00');

    const replay = await service.process('key-bet', input(wallet.id, 'BET'));
    expect(replay).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '80.00' },
      idempotentReplay: true,
    });
    expect(await em.count(LedgerOrmEntity)).toBe(3); // opening, bet and win
    expect(await em.count(WagerTransactionOrmEntity)).toBe(3);
  });

  it('rejects payload changes for the same idempotency key', async () => {
    const wallet = await walletRepository.create(
      'player-2',
      Money.from({ amount: '100.00', currency: 'BRL' }),
    );
    await service.process('key-conflict', input(wallet.id, 'BET', '10.00', 'player-2'));
    await expect(
      service.process('key-conflict', input(wallet.id, 'BET', '11.00', 'player-2')),
    ).rejects.toThrow('IDEMPOTENCY_PAYLOAD_CONFLICT');
    expect(await em.count(WagerTransactionOrmEntity)).toBe(2); // opening + original bet
    expect(await em.count(LedgerOrmEntity)).toBe(2);
  });

  it('rejects an insufficient BET without changing wallet or ledger', async () => {
    const wallet = await walletRepository.create('player-3', Money.zero('BRL'));
    const result = await service.process(
      'key-insufficient',
      input(wallet.id, 'BET', '1.00', 'player-3'),
    );
    expect(result).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '0.00' },
    });
    expect(await em.count(LedgerOrmEntity)).toBe(0);
    expect(await em.findOneOrFail(WalletOrmEntity, { id: wallet.id })).toMatchObject({
      balance: '0.00',
      version: 1,
    });
    expect(await em.count(OutboxOrmEntity, { eventType: 'WagerTransactionRejected' })).toBe(1);
  });

  it('credits WIN and processes LOSS without a ledger or version change', async () => {
    const wallet = await walletRepository.create('player-4', Money.zero('BRL'));
    const win = await service.process('key-win', input(wallet.id, 'WIN', '5.00', 'player-4'));
    expect(win.balance.amount).toBe('5.00');
    const beforeLoss = await em.findOneOrFail(WalletOrmEntity, { id: wallet.id });
    const ledgerBeforeLoss = await em.count(LedgerOrmEntity);
    const loss = await service.process('key-loss', input(wallet.id, 'LOSS', '5.00', 'player-4'));
    expect(loss).toMatchObject({ status: 'PROCESSED', balance: { amount: '5.00' } });
    const afterLoss = await em.findOneOrFail(WalletOrmEntity, { id: wallet.id });
    expect(afterLoss.version).toBe(beforeLoss.version);
    expect(await em.count(LedgerOrmEntity)).toBe(ledgerBeforeLoss);
    expect(await em.count(OutboxOrmEntity, { eventType: 'WagerTransactionProcessed' })).toBe(2);
  });
});

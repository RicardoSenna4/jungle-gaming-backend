import { MikroORM } from '@mikro-orm/postgresql';
import mikroOrmConfig from '../../src/infrastructure/database/mikro-orm.config';
import { WalletRepository } from '../../src/application/wallets/wallet-repository';
import { Money } from '../../src/domain/money';
import { WagerKind } from '../../src/domain/wager-transaction';
import {
  SubmitInput,
  WagerProcessingService,
} from '../../src/application/wager-processing.service';
import {
  LedgerOrmEntity,
  OutboxOrmEntity,
  WagerTransactionOrmEntity,
  WalletOrmEntity,
} from '../../src/infrastructure/database/mikro-orm/entities';

const describeIntegration = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;

describeIntegration('refund, rollback and out-of-order references', () => {
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
        'truncate table outbox_messages, wallet_ledger_entries, wager_transactions, wallets cascade',
      );
  });

  afterAll(async () => orm.close(true));

  function operation(
    walletId: string,
    externalTransactionId: string,
    kind: WagerKind,
    amount: string,
    playerId: string,
    referenceExternalTransactionId?: string,
  ): SubmitInput {
    return {
      providerId: 'provider-reversal',
      externalTransactionId,
      playerId,
      walletId,
      roundId: 'round-reversal',
      gameId: 'game-reversal',
      kind,
      money: { amount, currency: 'BRL' },
      referenceExternalTransactionId,
    };
  }

  it('processes a full REFUND of a BET once and replays it without a second ledger entry', async () => {
    const wallet = await walletRepository.create(
      'refund-player',
      Money.from({ amount: '100.00', currency: 'BRL' }),
    );
    const betInput = operation(wallet.id, 'bet-refund', WagerKind.BET, '20.00', 'refund-player');
    await service.process('key-bet-refund', betInput);
    const refundInput = operation(
      wallet.id,
      'refund-1',
      WagerKind.REFUND,
      '20.00',
      'refund-player',
      'bet-refund',
    );
    const refund = await service.process('key-refund-1', refundInput);
    const replay = await service.process('key-refund-1', refundInput);

    expect(refund).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' } });
    expect(replay.idempotentReplay).toBe(true);
    expect(await em.count(LedgerOrmEntity, { walletId: wallet.id })).toBe(3);
    expect(await em.count(WagerTransactionOrmEntity, { kind: WagerKind.REFUND })).toBe(1);
    expect(await em.count(OutboxOrmEntity, { eventType: 'WagerTransactionProcessed' })).toBe(2);
  });

  it('processes ROLLBACK of WIN and rejects a second reversal of the same reference', async () => {
    const wallet = await walletRepository.create('rollback-player', Money.zero('BRL'));
    const win = operation(wallet.id, 'win-rollback', WagerKind.WIN, '25.00', 'rollback-player');
    await service.process('key-win-rollback', win);
    const rollback = operation(
      wallet.id,
      'rollback-win',
      WagerKind.ROLLBACK,
      '25.00',
      'rollback-player',
      'win-rollback',
    );
    const result = await service.process('key-rollback-win', rollback);
    const duplicate = await service.process(
      'key-rollback-win-duplicate',
      operation(
        wallet.id,
        'rollback-win-2',
        WagerKind.ROLLBACK,
        '25.00',
        'rollback-player',
        'win-rollback',
      ),
    );

    expect(result).toMatchObject({ status: 'PROCESSED', balance: { amount: '0.00' } });
    expect(duplicate).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REVERSAL_ALREADY_APPLIED',
    });
    expect(await em.count(LedgerOrmEntity, { walletId: wallet.id })).toBe(2);
  });

  it('rejects incompatible reference, amount mismatch and reversal that would make balance negative', async () => {
    const wallet = await walletRepository.create('invalid-reversal', Money.zero('BRL'));
    await service.process(
      'key-win-invalid',
      operation(wallet.id, 'win-invalid', WagerKind.WIN, '25.00', 'invalid-reversal'),
    );
    await service.process(
      'key-bet-invalid',
      operation(wallet.id, 'bet-invalid', WagerKind.BET, '25.00', 'invalid-reversal'),
    );
    const insufficient = await service.process(
      'key-rollback-insufficient',
      operation(
        wallet.id,
        'rollback-insufficient',
        WagerKind.ROLLBACK,
        '25.00',
        'invalid-reversal',
        'win-invalid',
      ),
    );
    expect(insufficient).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REVERSAL_INSUFFICIENT_FUNDS',
    });
    expect(await em.count(LedgerOrmEntity, { walletId: wallet.id })).toBe(2);

    const mismatch = await service.process(
      'key-mismatch',
      operation(
        wallet.id,
        'refund-mismatch',
        WagerKind.REFUND,
        '20.00',
        'invalid-reversal',
        'win-invalid',
      ),
    );
    expect(mismatch).toMatchObject({ status: 'REJECTED', failureCode: 'INVALID_REFERENCE_KIND' });
    expect(await em.findOneOrFail(WalletOrmEntity, { id: wallet.id })).toMatchObject({
      balance: '0.00',
    });
  });

  it('keeps REFUND pending before BET, then reprocesses and applies it after the reference arrives', async () => {
    const wallet = await walletRepository.create(
      'out-of-order',
      Money.from({ amount: '10.00', currency: 'BRL' }),
    );
    const refundInput = operation(
      wallet.id,
      'refund-before-bet',
      WagerKind.REFUND,
      '10.00',
      'out-of-order',
      'bet-late',
    );
    const pending = await service.process('key-pending-refund', refundInput);
    expect(pending.status).toBe('PENDING_REFERENCE');

    await service.process(
      'key-late-bet',
      operation(wallet.id, 'bet-late', WagerKind.BET, '10.00', 'out-of-order'),
    );
    const applied = await service.reprocessPendingReference(
      pending.transactionId,
      new Date(Date.now() + 2_000),
    );

    expect(applied).toMatchObject({ status: 'PROCESSED', balance: { amount: '10.00' } });
    expect(await em.count(LedgerOrmEntity, { walletId: wallet.id })).toBe(3);
    expect(
      await em.findOneOrFail(WagerTransactionOrmEntity, { id: pending.transactionId }),
    ).toMatchObject({
      status: 'PROCESSED',
      referenceTransactionId: expect.any(String),
    });
  });

  it('expires a pending reference with a stable rejection and outbox event', async () => {
    const wallet = await walletRepository.create('expired-reference', Money.zero('BRL'));
    const pending = await service.process(
      'key-expired-reference',
      operation(
        wallet.id,
        'refund-expired',
        WagerKind.REFUND,
        '10.00',
        'expired-reference',
        'never-arrives',
      ),
    );
    await em.nativeUpdate(
      WagerTransactionOrmEntity,
      { id: pending.transactionId },
      { referenceExpiresAt: new Date(Date.now() - 1_000) },
    );
    const expired = await service.reprocessPendingReference(
      pending.transactionId,
      new Date(Date.now() + 2_000),
    );

    expect(expired).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_RETRY_EXHAUSTED' });
    expect(await em.count(LedgerOrmEntity, { walletId: wallet.id })).toBe(0);
    expect(await em.count(OutboxOrmEntity, { eventType: 'WagerTransactionRejected' })).toBe(1);
  });
});

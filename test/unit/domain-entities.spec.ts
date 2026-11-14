import { InboxMessage } from '../../src/domain/messaging/inbox-message';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { InvalidTransactionStateError } from '../../src/domain/errors';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/ledger';
import {
  FailureCode,
  WagerKind,
  WagerStatus,
  WagerTransaction,
} from '../../src/domain/wager-transaction';
import { Money } from '../../src/domain/money';

describe('InboxMessage', () => {
  it('receives, rehydrates and marks a message exactly once', () => {
    const receivedAt = new Date('2026-01-01T00:00:00.000Z');
    const message = InboxMessage.receive({
      messageId: 'message-1',
      consumerName: 'wager-consumer',
      payloadHash: 'a'.repeat(64),
      receivedAt,
    });

    expect(message.isProcessed()).toBe(false);
    message.markProcessed(new Date('2026-01-01T00:00:01.000Z'));
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt?.toISOString()).toBe('2026-01-01T00:00:01.000Z');
    expect(() => message.markProcessed(new Date())).toThrow(InvalidTransactionStateError);

    const rehydrated = InboxMessage.rehydrate({
      messageId: 'message-1',
      consumerName: 'wager-consumer',
      payloadHash: 'a'.repeat(64),
      receivedAt,
      processedAt: message.processedAt,
    });
    expect(rehydrated.isProcessed()).toBe(true);
  });
});

describe('OutboxMessage', () => {
  const event = {
    eventId: 'event-1',
    eventType: 'TestEvent',
    aggregateId: 'aggregate-1',
    correlationId: 'correlation-1',
    occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    version: 1,
    toJSON: () => ({
      eventId: 'event-1',
      eventType: 'TestEvent',
      aggregateId: 'aggregate-1',
      correlationId: 'correlation-1',
      occurredAt: '2026-01-01T00:00:00.000Z',
      version: 1,
      data: { value: 'safe' },
    }),
  } as never;

  it('is due initially, applies bounded exponential retry and publishes once', () => {
    const message = OutboxMessage.enqueue(event);
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(message.isPending()).toBe(true);
    expect(message.isDue(now)).toBe(true);

    message.scheduleRetry(now);
    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt?.toISOString()).toBe('2026-01-01T00:00:01.000Z');
    expect(message.isDue(now)).toBe(false);
    expect(message.isDue(new Date('2026-01-01T00:00:01.000Z'))).toBe(true);

    message.markPublished(new Date('2026-01-01T00:00:02.000Z'));
    expect(message.isPending()).toBe(false);
    expect(message.publishedAt?.toISOString()).toBe('2026-01-01T00:00:02.000Z');
    expect(() => message.markPublished(new Date())).toThrow(InvalidTransactionStateError);
  });
});

describe('WagerTransaction state machine', () => {
  const props = {
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'external-1',
    idempotencyKey: 'key-1',
    payloadHash: 'b'.repeat(64),
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerKind.BET,
    money: Money.from({ amount: '10.00', currency: 'BRL' }),
  };

  it('rehydrates persisted terminal state and blocks every transition', () => {
    const tx = WagerTransaction.rehydrate({
      ...props,
      status: WagerStatus.REJECTED,
      failureCode: FailureCode.INSUFFICIENT_FUNDS,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      processedAt: new Date('2026-01-01T00:00:01.000Z'),
    });

    expect(tx.isTerminal()).toBe(true);
    expect(tx.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);
    expect(() => tx.markProcessed()).toThrow(InvalidTransactionStateError);
    expect(() => tx.reject(FailureCode.INVALID_OPERATION)).toThrow(InvalidTransactionStateError);
    expect(() => tx.fail(FailureCode.INVALID_OPERATION)).toThrow(InvalidTransactionStateError);
  });

  it('exposes reference and ledger policy without mutating state', () => {
    const tx = WagerTransaction.create({ ...props, kind: WagerKind.LOSS });
    expect(tx.affectsBalance()).toBe(false);
    expect(tx.requiresReference()).toBe(false);
    expect(tx.matchesPayload(props.payloadHash)).toBe(true);
    tx.markProcessed();
    expect(tx.status).toBe(WagerStatus.PROCESSED);
  });

  it('rejects external OPENING and requires references for reversals', () => {
    expect(() => WagerTransaction.create({ ...props, kind: WagerKind.OPENING })).toThrow(
      'OPENING_EXTERNAL',
    );
    expect(() =>
      WagerTransaction.create({
        ...props,
        kind: WagerKind.REFUND,
        referenceExternalTransactionId: undefined,
      }),
    ).toThrow('REFERENCE_REQUIRED');
  });

  it('maps a rollback to the inverse ledger direction', () => {
    const bet = WagerTransaction.create({ ...props, kind: WagerKind.BET });
    const rollback = WagerTransaction.create({
      ...props,
      id: 'tx-2',
      externalTransactionId: 'external-2',
      kind: WagerKind.ROLLBACK,
      referenceExternalTransactionId: 'external-1',
    });
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.DEBIT);
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.CREDIT);
  });
});

describe('WalletLedgerEntry', () => {
  it('validates arithmetic and rehydrates an immutable timestamp', () => {
    const before = Money.from({ amount: '10.00', currency: 'BRL' });
    const amount = Money.from({ amount: '2.50', currency: 'BRL' });
    const after = Money.from({ amount: '12.50', currency: 'BRL' });
    const entry = WalletLedgerEntry.create({
      id: 'ledger-1',
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      direction: LedgerDirection.CREDIT,
      money: amount,
      balanceBefore: before,
      balanceAfter: after,
    });
    expect(entry.isBalanced()).toBe(true);
    expect(() =>
      WalletLedgerEntry.create({
        id: 'ledger-2',
        walletId: 'wallet-1',
        transactionId: 'tx-2',
        direction: LedgerDirection.CREDIT,
        money: amount,
        balanceBefore: before,
        balanceAfter: before,
      }),
    ).toThrow('UNBALANCED_LEDGER');

    const original = entry.createdAt;
    original.setFullYear(2030);
    expect(entry.createdAt.getUTCFullYear()).toBe(new Date().getUTCFullYear());
  });
});

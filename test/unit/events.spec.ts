import { IntegrationEvent } from '../../src/domain/events/integration-event';
import { WagerTransactionProcessed } from '../../src/domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../../src/domain/events/wager-transaction-rejected';
import { WagerTransactionPendingReference } from '../../src/domain/events/wager-transaction-pending-reference';
import { WalletBalanceChanged } from '../../src/domain/events/wallet-balance-changed';

const context = {
  eventId: 'event-1',
  aggregateId: 'tx-1',
  correlationId: 'correlation-1',
  causationId: 'message-1',
  occurredAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('integration events', () => {
  it.each([
    [WagerTransactionProcessed, 'WagerTransactionProcessed'],
    [WagerTransactionRejected, 'WagerTransactionRejected'],
    [WagerTransactionPendingReference, 'WagerTransactionPendingReference'],
  ])('%s serializes a versioned envelope with string money data', (EventType, eventType) => {
    const event = new EventType({
      ...context,
      data: {
        transactionId: 'tx-1',
        status: 'PROCESSED',
        money: { amount: '10.00', currency: 'BRL' },
      },
    });

    expect(event).toBeInstanceOf(IntegrationEvent);
    expect(event.eventType).toBe(eventType);
    expect(event.version).toBe(1);
    expect(event.toJSON()).toMatchObject({
      eventId: 'event-1',
      eventType,
      aggregateId: 'tx-1',
      correlationId: 'correlation-1',
      causationId: 'message-1',
      occurredAt: '2026-01-01T00:00:00.000Z',
      version: 1,
    });
    expect(event.toJSON().data.money).toEqual({ amount: '10.00', currency: 'BRL' });
  });

  it('serializes WalletBalanceChanged with wallet version and money props', () => {
    const event = new WalletBalanceChanged({
      ...context,
      aggregateId: 'wallet-1',
      data: {
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: 'CREDIT',
        money: { amount: '10.00', currency: 'BRL' },
        balanceBefore: { amount: '0.00', currency: 'BRL' },
        balanceAfter: { amount: '10.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });

    expect(event.eventType).toBe('WalletBalanceChanged');
    expect(event.toJSON().data).toEqual({
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      direction: 'CREDIT',
      money: { amount: '10.00', currency: 'BRL' },
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '10.00', currency: 'BRL' },
      walletVersion: 2,
    });
  });
});

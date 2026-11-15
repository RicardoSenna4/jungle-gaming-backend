import { randomUUID } from 'node:crypto';
import { IntegrationEvent } from './integration-event';
import {
  WagerTransactionEventData,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from './wager-events';
import { WalletBalanceChanged, WalletBalanceChangedData } from './wallet-balance-changed';

export type WagerEventType =
  'WagerTransactionProcessed' | 'WagerTransactionRejected' | 'WagerTransactionPendingReference';

export function createWagerEvent(
  eventType: WagerEventType,
  aggregateId: string,
  correlationId: string,
  data: WagerTransactionEventData,
): IntegrationEvent<WagerTransactionEventData> {
  const props = {
    eventId: randomUUID(),
    aggregateId,
    correlationId,
    occurredAt: new Date(),
    data,
  };
  if (eventType === 'WagerTransactionProcessed') return new WagerTransactionProcessed(props);
  if (eventType === 'WagerTransactionRejected') return new WagerTransactionRejected(props);
  return new WagerTransactionPendingReference(props);
}

export function createWalletBalanceChangedEvent(
  aggregateId: string,
  correlationId: string,
  data: WalletBalanceChangedData,
): WalletBalanceChanged {
  return new WalletBalanceChanged({
    eventId: randomUUID(),
    aggregateId,
    correlationId,
    occurredAt: new Date(),
    data,
  });
}

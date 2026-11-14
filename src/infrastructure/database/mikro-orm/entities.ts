import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/core';

@Entity({ tableName: 'wallets' })
@Unique({ properties: ['playerId', 'currency'] })
export class WalletOrmEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'player_id' })
  playerId!: string;

  @Property({ length: 3 })
  currency!: string;

  @Property({ columnType: 'numeric(20,2)' })
  balance!: string;

  @Property()
  version!: number;

  @Property({ fieldName: 'created_at', onCreate: () => new Date() })
  createdAt?: Date;

  @Property({ fieldName: 'updated_at', onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt?: Date;
}

@Entity({ tableName: 'wager_transactions' })
@Unique({ properties: ['providerId', 'externalTransactionId'] })
@Unique({ properties: ['providerId', 'idempotencyKey'] })
@Unique({ properties: ['referenceTransactionId'] })
export class WagerTransactionOrmEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'provider_id' })
  providerId!: string;

  @Property({ fieldName: 'external_transaction_id' })
  externalTransactionId!: string;

  @Property({ fieldName: 'idempotency_key' })
  idempotencyKey!: string;

  @Property({ fieldName: 'payload_hash', length: 64 })
  payloadHash!: string;

  @Property({ fieldName: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @Property({ fieldName: 'player_id' })
  playerId!: string;

  @Property({ fieldName: 'round_id' })
  roundId!: string;

  @Property({ fieldName: 'game_id' })
  gameId!: string;

  @Property({ length: 16 })
  kind!: string;

  @Property({ columnType: 'numeric(20,2)' })
  amount!: string;

  @Property({ length: 3 })
  currency!: string;

  @Property({ length: 24 })
  status!: string;

  @Property({ fieldName: 'reference_external_transaction_id', nullable: true })
  referenceExternalTransactionId?: string;

  @Property({ fieldName: 'reference_transaction_id', type: 'uuid', nullable: true })
  referenceTransactionId?: string;

  @Property({ fieldName: 'failure_code', nullable: true })
  failureCode?: string;

  @Property({ fieldName: 'response_snapshot', type: 'json', nullable: true })
  responseSnapshot?: Record<string, unknown>;

  @Property({ fieldName: 'created_at', onCreate: () => new Date() })
  createdAt?: Date;

  @Property({ fieldName: 'processed_at', nullable: true })
  processedAt?: Date;

  @Property({ fieldName: 'reference_attempts', default: 0 })
  referenceAttempts = 0;

  @Property({ fieldName: 'reference_next_attempt_at', nullable: true })
  referenceNextAttemptAt?: Date;

  @Property({ fieldName: 'reference_expires_at', nullable: true })
  referenceExpiresAt?: Date;
}

@Entity({ tableName: 'wallet_ledger_entries' })
@Unique({ properties: ['walletId', 'transactionId'] })
@Index({ properties: ['walletId', 'createdAt', 'id'] })
export class LedgerOrmEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @Property({ fieldName: 'transaction_id', type: 'uuid' })
  transactionId!: string;

  @Property({ length: 6 })
  direction!: string;

  @Property({ columnType: 'numeric(20,2)' })
  amount!: string;

  @Property({ length: 3 })
  currency!: string;

  @Property({ fieldName: 'balance_before', columnType: 'numeric(20,2)' })
  balanceBefore!: string;

  @Property({ fieldName: 'balance_after', columnType: 'numeric(20,2)' })
  balanceAfter!: string;

  @Property({ fieldName: 'created_at', onCreate: () => new Date() })
  createdAt?: Date;
}

@Entity({ tableName: 'inbox_messages' })
@Unique({ properties: ['consumerName', 'messageId'] })
export class InboxOrmEntity {
  @PrimaryKey({ fieldName: 'message_id' })
  messageId!: string;

  @PrimaryKey({ fieldName: 'consumer_name' })
  consumerName!: string;

  @Property({ fieldName: 'payload_hash', length: 64 })
  payloadHash!: string;

  @Property({ fieldName: 'received_at', onCreate: () => new Date() })
  receivedAt!: Date;

  @Property({ fieldName: 'processed_at', nullable: true })
  processedAt?: Date;
}

@Entity({ tableName: 'outbox_messages' })
@Index({ properties: ['publishedAt', 'nextAttemptAt'] })
export class OutboxOrmEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'aggregate_id', type: 'uuid' })
  aggregateId!: string;

  @Property({ fieldName: 'event_type' })
  eventType!: string;

  @Property({ type: 'json' })
  payload!: Record<string, unknown>;

  @Property({ fieldName: 'occurred_at', onCreate: () => new Date() })
  occurredAt?: Date;

  @Property({ default: 0 })
  attempts = 0;

  @Property({ fieldName: 'next_attempt_at', nullable: true })
  nextAttemptAt?: Date;

  @Property({ fieldName: 'claimed_until', nullable: true })
  claimedUntil?: Date;

  @Property({ fieldName: 'published_at', nullable: true })
  publishedAt?: Date;
}

import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
@Entity('wallets')
@Index(['playerId', 'currency'], { unique: true })
export class WalletEntity {
  @PrimaryColumn('uuid') id!: string;
  @Column({ name: 'player_id' }) playerId!: string;
  @Column({ length: 3 }) currency!: string;
  @Column({ type: 'numeric', precision: 20, scale: 2 }) balance!: string;
  @Column('integer') version!: number;
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}
@Entity('wager_transactions')
@Index(['providerId', 'externalTransactionId'], { unique: true })
@Index(['providerId', 'idempotencyKey'], { unique: true })
export class WagerTransactionEntity {
  @PrimaryColumn('uuid') id!: string;
  @Column({ name: 'provider_id' }) providerId!: string;
  @Column({ name: 'external_transaction_id' }) externalTransactionId!: string;
  @Column({ name: 'idempotency_key' }) idempotencyKey!: string;
  @Column({ name: 'payload_hash', length: 64 }) payloadHash!: string;
  @Column({ name: 'wallet_id', type: 'uuid' }) walletId!: string;
  @Column({ name: 'player_id' }) playerId!: string;
  @Column({ name: 'round_id' }) roundId!: string;
  @Column({ name: 'game_id' }) gameId!: string;
  @Column({ length: 16 }) kind!: string;
  @Column({ type: 'numeric', precision: 20, scale: 2 }) amount!: string;
  @Column({ length: 3 }) currency!: string;
  @Column({ length: 24 }) status!: string;
  @Column({ name: 'reference_external_transaction_id', nullable: true })
  referenceExternalTransactionId!: string | null;
  @Column({ name: 'failure_code', nullable: true }) failureCode!: string | null;
  @Column({ name: 'response_snapshot', type: 'jsonb', nullable: true }) responseSnapshot!:
    string | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @Column({ name: 'processed_at', nullable: true }) processedAt!: Date | null;
}
@Entity('wallet_ledger_entries')
@Index(['walletId', 'transactionId'], { unique: true })
export class LedgerEntity {
  @PrimaryColumn('uuid') id!: string;
  @Column({ name: 'wallet_id', type: 'uuid' }) walletId!: string;
  @Column({ name: 'transaction_id', type: 'uuid' }) transactionId!: string;
  @Column({ length: 6 }) direction!: string;
  @Column({ type: 'numeric', precision: 20, scale: 2 }) amount!: string;
  @Column({ length: 3 }) currency!: string;
  @Column({ name: 'balance_before', type: 'numeric', precision: 20, scale: 2 })
  balanceBefore!: string;
  @Column({ name: 'balance_after', type: 'numeric', precision: 20, scale: 2 })
  balanceAfter!: string;
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
}

@Entity('outbox_messages')
export class OutboxEntity {
  @PrimaryColumn('uuid') id!: string;
  @Column({ name: 'aggregate_id', type: 'uuid' }) aggregateId!: string;
  @Column({ name: 'event_type' }) eventType!: string;
  @Column({ type: 'jsonb' }) payload!: Record<string, unknown>;
  @CreateDateColumn({ name: 'occurred_at' }) occurredAt!: Date;
  @Column('integer', { default: 0 }) attempts!: number;
  @Column({ name: 'next_attempt_at', nullable: true }) nextAttemptAt!: Date | null;
  @Column({ name: 'published_at', nullable: true }) publishedAt!: Date | null;
}

import { Migration } from '@mikro-orm/migrations';

export class Migration20261114130000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table wager_transactions
        add column if not exists reference_attempts integer not null default 0 check (reference_attempts >= 0),
        add column if not exists reference_next_attempt_at timestamptz,
        add column if not exists reference_expires_at timestamptz;

      create unique index if not exists wager_transactions_reference_unique_idx
        on wager_transactions (reference_transaction_id)
        where reference_transaction_id is not null;

      create index if not exists wager_transactions_pending_due_idx
        on wager_transactions (status, reference_next_attempt_at, reference_expires_at)
        where status = 'PENDING_REFERENCE';
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      drop index if exists wager_transactions_pending_due_idx;
      drop index if exists wager_transactions_reference_unique_idx;
      alter table wager_transactions
        drop column if exists reference_expires_at,
        drop column if exists reference_next_attempt_at,
        drop column if exists reference_attempts;
    `);
  }
}

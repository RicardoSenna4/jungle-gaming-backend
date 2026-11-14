import { Migration } from '@mikro-orm/migrations';

export class Migration20261114140000 extends Migration {
  override async up(): Promise<void> {
    this.addSql('alter table outbox_messages add column if not exists claim_token uuid null;');
    this.addSql(
      'create index if not exists outbox_claim_idx on outbox_messages (published_at, next_attempt_at, claimed_until, occurred_at);',
    );
    this.addSql(
      'create index if not exists outbox_unpublished_order_idx on outbox_messages (occurred_at, id) where published_at is null;',
    );
  }

  override async down(): Promise<void> {
    this.addSql('drop index if exists outbox_unpublished_order_idx;');
    this.addSql('drop index if exists outbox_claim_idx;');
    this.addSql('alter table outbox_messages drop column if exists claim_token;');
  }
}

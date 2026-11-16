import { Migration } from '@mikro-orm/migrations';

export class Migration20261116110000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table if not exists message_quarantine (
        message_id varchar(255) not null,
        consumer_name varchar(128) not null,
        reason varchar(64) not null,
        raw_payload text not null,
        receive_count integer not null default 1 check (receive_count > 0),
        status varchar(16) not null default 'OPEN'
          check (status in ('OPEN', 'RELEASED', 'RESOLVED')),
        first_seen_at timestamptz not null default now(),
        last_seen_at timestamptz not null default now(),
        resolved_at timestamptz,
        resolution_note text,
        primary key (message_id, consumer_name)
      );
      create index if not exists message_quarantine_status_idx
        on message_quarantine (status, last_seen_at);
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      drop index if exists message_quarantine_status_idx;
      drop table if exists message_quarantine;
    `);
  }
}

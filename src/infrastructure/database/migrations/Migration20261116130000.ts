import { Migration } from '@mikro-orm/migrations';

export class Migration20261116130000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table operator_grants drop constraint operator_grants_action_check;
      alter table operator_grants add constraint operator_grants_action_check check (action in ('quarantine.read','quarantine.resolve','quarantine.redrive'));
      alter table message_quarantine drop constraint message_quarantine_status_check;
      alter table message_quarantine add constraint message_quarantine_status_check check (status in ('OPEN','REDRIVING','RELEASED','RESOLVED'));
      create index quarantine_page_idx on message_quarantine (last_seen_at desc, consumer_name desc, message_id desc);
      create table quarantine_redrive_attempts (
        id uuid primary key, consumer_name varchar(128) not null, message_id varchar(255) not null,
        request_key varchar(128) not null check (length(btrim(request_key)) > 0),
        actor_issuer text not null, actor_subject text not null,
        justification text not null check (length(btrim(justification)) between 1 and 1024),
        payload text not null, queue_url text not null, group_id varchar(128) not null,
        state varchar(16) not null check (state in ('PENDING','SENT','FAILED')),
        lease_token uuid not null, lease_until timestamptz not null,
        created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
        error_code varchar(64),
        foreign key (message_id,consumer_name) references message_quarantine(message_id,consumer_name) on delete restrict,
        unique (consumer_name,message_id,request_key));
      create index quarantine_redrive_history_idx on quarantine_redrive_attempts (consumer_name,message_id,created_at desc);
      create table quarantine_operation_events (
        id uuid primary key, attempt_id uuid references quarantine_redrive_attempts(id) on delete restrict,
        consumer_name varchar(128) not null, message_id varchar(255) not null,
        foreign key(message_id,consumer_name) references message_quarantine(message_id,consumer_name) on delete restrict,
        actor_issuer text not null, actor_subject text not null, event varchar(32) not null,
        justification text not null, occurred_at timestamptz not null default clock_timestamp());
      create index quarantine_operation_events_attempt_idx on quarantine_operation_events(attempt_id,occurred_at);
      create trigger quarantine_operation_events_immutable before update or delete on quarantine_operation_events for each row execute function authorization_audit_immutable();`);
  }
  override async down(): Promise<void> {
    this.addSql(
      `do $$ begin if exists(select 1 from message_quarantine where status = 'REDRIVING') then raise exception 'recover active redrives before rollback'; end if; end $$;`,
    );
    if (process.env.QUARANTINE_ROLLBACK_BACKUP_CONFIRMED !== '1')
      this.addSql(
        `do $$ begin if exists(select 1 from quarantine_redrive_attempts) or exists(select 1 from operator_grants where action = 'quarantine.redrive') then raise exception 'verified quarantine/grant backup required'; end if; end $$;`,
      );
    // Revoked/active redrive grants must be archived before removal, never transferred to resolve.
    this.addSql(`drop table quarantine_operation_events, quarantine_redrive_attempts;
      drop index quarantine_page_idx;
      alter table message_quarantine drop constraint message_quarantine_status_check;
      alter table message_quarantine add constraint message_quarantine_status_check check (status in ('OPEN','RELEASED','RESOLVED'));
      alter table operator_grants disable trigger operator_grants_audit;
      delete from operator_grants where action = 'quarantine.redrive';
      alter table operator_grants enable trigger operator_grants_audit;
      alter table operator_grants drop constraint operator_grants_action_check;
      alter table operator_grants add constraint operator_grants_action_check check (action in ('quarantine.read','quarantine.resolve'));`);
  }
}

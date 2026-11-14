import { Migration } from '@mikro-orm/migrations';

export class Migration20261113150000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table if not exists wallets (
        id uuid primary key,
        player_id text not null,
        currency varchar(3) not null check (currency ~ '^[A-Z]{3}$'),
        balance numeric(20,2) not null check (balance >= 0),
        version integer not null check (version >= 1),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (player_id, currency)
      );

      create table if not exists wager_transactions (
        id uuid primary key,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash varchar(64) not null check (payload_hash ~ '^[0-9a-fA-F]{64}$'),
        wallet_id uuid not null references wallets(id),
        player_id text not null,
        round_id text not null,
        game_id text not null,
        kind varchar(16) not null check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount numeric(20,2) not null check (amount > 0),
        currency varchar(3) not null check (currency ~ '^[A-Z]{3}$'),
        status varchar(24) not null check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        reference_external_transaction_id text,
        reference_transaction_id uuid references wager_transactions(id),
        failure_code text,
        response_snapshot jsonb,
        created_at timestamptz not null default now(),
        processed_at timestamptz,
        unique (provider_id, external_transaction_id),
        unique (provider_id, idempotency_key)
      );

      create table if not exists wallet_ledger_entries (
        id uuid primary key,
        wallet_id uuid not null references wallets(id),
        transaction_id uuid not null references wager_transactions(id),
        direction varchar(6) not null check (direction in ('DEBIT','CREDIT')),
        amount numeric(20,2) not null check (amount > 0),
        currency varchar(3) not null check (currency ~ '^[A-Z]{3}$'),
        balance_before numeric(20,2) not null check (balance_before >= 0),
        balance_after numeric(20,2) not null check (balance_after >= 0),
        created_at timestamptz not null default now(),
        unique (wallet_id, transaction_id),
        check (
          (direction = 'CREDIT' and balance_after = balance_before + amount)
          or (direction = 'DEBIT' and balance_after = balance_before - amount)
        )
      );

      create table if not exists inbox_messages (
        message_id text not null,
        consumer_name text not null,
        payload_hash varchar(64) not null check (payload_hash ~ '^[0-9a-fA-F]{64}$'),
        received_at timestamptz not null default now(),
        processed_at timestamptz,
        primary key (consumer_name, message_id)
      );

      create table if not exists outbox_messages (
        id uuid primary key,
        aggregate_id uuid not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null default now(),
        attempts integer not null default 0 check (attempts >= 0),
        next_attempt_at timestamptz,
        claimed_until timestamptz,
        published_at timestamptz
      );

      create index if not exists ledger_wallet_cursor_idx
        on wallet_ledger_entries (wallet_id, created_at desc, id desc);
      create index if not exists transactions_wallet_idx
        on wager_transactions (wallet_id, created_at desc, id desc);
      create index if not exists outbox_due_idx
        on outbox_messages (published_at, next_attempt_at, claimed_until);
      create index if not exists pending_reference_idx
        on wager_transactions (status, created_at)
        where status = 'PENDING_REFERENCE';

      create or replace function deny_ledger_mutation()
      returns trigger language plpgsql as $$
      begin
        raise exception 'ledger is append-only';
      end;
      $$;

      drop trigger if exists wallet_ledger_append_only on wallet_ledger_entries;
      create trigger wallet_ledger_append_only
        before update or delete on wallet_ledger_entries
        for each row execute function deny_ledger_mutation();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      drop trigger if exists wallet_ledger_append_only on wallet_ledger_entries;
      drop function if exists deny_ledger_mutation();
      drop table if exists outbox_messages;
      drop table if exists inbox_messages;
      drop table if exists wallet_ledger_entries;
      drop table if exists wager_transactions;
      drop table if exists wallets;
    `);
  }
}

import { Migration } from '@mikro-orm/migrations';

/** Additive only: no legacy ownership inference and no financial table rewrite. */
export class Migration20261116120000 extends Migration {
  override async up(): Promise<void> {
    const metadata = `granted_at timestamptz not null default clock_timestamp(),
      revoked_at timestamptz check (revoked_at >= granted_at),
      source text not null check (btrim(source) <> ''),
      actor_issuer text not null check (btrim(actor_issuer) <> ''),
      actor_subject text not null check (btrim(actor_subject) <> '')`;
    const provider = `provider_id text not null check (btrim(provider_id) <> '' and provider_id !~ '^__')`;
    const identity = `issuer text not null check (btrim(issuer) <> ''), subject text not null check (btrim(subject) <> '')`;
    this.addSql(`
      create table provider_principal_bindings (${identity}, ${provider}, ${metadata}, primary key (issuer, subject, provider_id));
      create table provider_wallet_grants (${provider}, wallet_id uuid not null references wallets(id) on delete restrict,
        capability text not null check (capability in ('balance.read','wager.submit','transaction.read_own','ledger.read_all','reconcile')),
        ${metadata}, primary key (provider_id, wallet_id, capability));
      create index provider_wallet_grants_wallet_idx on provider_wallet_grants (wallet_id, provider_id);
      create table provider_player_grants (${provider}, player_id text not null check (btrim(player_id) <> ''),
        currency varchar(3) not null check (currency ~ '^[A-Z]{3}$'),
        capability text not null check (capability in ('wallet.create','wallet.opening.credit')),
        ${metadata}, primary key (provider_id, player_id, currency, capability));
      create table operator_grants (${identity}, action text not null check (action in ('quarantine.read','quarantine.resolve')),
        ${metadata}, primary key (issuer, subject, action));
      create table authorization_audit (
        id uuid primary key, actor_issuer text not null check (btrim(actor_issuer) <> ''),
        actor_subject text not null check (btrim(actor_subject) <> ''), provider_id text,
        action text not null, resource text not null, decision text not null check (decision in ('allow','deny','grant','revoke')),
        source text not null check (btrim(source) <> ''), correlation_id uuid not null,
        occurred_at timestamptz not null default clock_timestamp());
      create index authorization_audit_actor_idx on authorization_audit (actor_issuer, actor_subject, occurred_at);
      create index authorization_audit_resource_idx on authorization_audit (resource, occurred_at);
      create function authorization_audit_immutable() returns trigger language plpgsql as $$
        begin raise exception 'authorization audit is append-only'; end; $$;
      create trigger authorization_audit_immutable before update or delete on authorization_audit
        for each row execute function authorization_audit_immutable();
      create function authorization_grant_audit() returns trigger language plpgsql as $$
        begin
          if TG_OP = 'DELETE' then raise exception 'revoke authorization grants instead of deleting them'; end if;
          insert into authorization_audit (id, actor_issuer, actor_subject, provider_id, action, resource, decision, source, correlation_id)
          values (gen_random_uuid(), NEW.actor_issuer, NEW.actor_subject, to_jsonb(NEW)->>'provider_id',
            TG_TABLE_NAME, (to_jsonb(NEW) - 'actor_issuer' - 'actor_subject' - 'source' - 'granted_at' - 'revoked_at')::text,
            case when NEW.revoked_at is null then 'grant' else 'revoke' end, NEW.source, gen_random_uuid());
          return NEW;
        end; $$;
    `);
    for (const table of [
      'provider_principal_bindings',
      'provider_wallet_grants',
      'provider_player_grants',
      'operator_grants',
    ]) {
      this.addSql(
        `create trigger ${table}_audit after insert or update or delete on ${table} for each row execute function authorization_grant_audit();`,
      );
    }
  }

  override async down(): Promise<void> {
    // Explicit operator acknowledgement after a verified backup; empty test schemas need none.
    if (process.env.AUTHZ_ROLLBACK_BACKUP_CONFIRMED !== '1') {
      this.addSql(`do $$ begin
        if exists (select 1 from authorization_audit) or exists (select 1 from provider_principal_bindings)
          or exists (select 1 from provider_wallet_grants) or exists (select 1 from provider_player_grants)
          or exists (select 1 from operator_grants) then
          raise exception 'authorization rollback requires a verified backup and AUTHZ_ROLLBACK_BACKUP_CONFIRMED=1';
        end if;
      end $$;`);
    }
    this
      .addSql(`drop table operator_grants, provider_player_grants, provider_wallet_grants, provider_principal_bindings;
      drop function authorization_grant_audit();
      drop table authorization_audit;
      drop function authorization_audit_immutable();`);
  }
}

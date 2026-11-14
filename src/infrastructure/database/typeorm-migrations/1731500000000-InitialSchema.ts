import { MigrationInterface, QueryRunner } from 'typeorm';
export class InitialSchema1731500000000 implements MigrationInterface {
  name = 'InitialSchema1731500000000';
  async up(q: QueryRunner) {
    await q.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await q.query(
      `CREATE TABLE wallets(id uuid PRIMARY KEY,player_id text NOT NULL,currency varchar(3) NOT NULL,balance numeric(20,2) NOT NULL CHECK(balance>=0),version integer NOT NULL CHECK(version>=1),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(player_id,currency));CREATE TABLE wager_transactions(id uuid PRIMARY KEY,provider_id text NOT NULL,external_transaction_id text NOT NULL,idempotency_key text NOT NULL,payload_hash varchar(64) NOT NULL,wallet_id uuid NOT NULL REFERENCES wallets(id),player_id text NOT NULL,round_id text NOT NULL,game_id text NOT NULL,kind varchar(16) NOT NULL CHECK(kind IN('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),amount numeric(20,2) NOT NULL CHECK(amount>0),currency varchar(3) NOT NULL,status varchar(24) NOT NULL,failure_code text,reference_external_transaction_id text,response_snapshot jsonb,created_at timestamptz NOT NULL DEFAULT now(),processed_at timestamptz,UNIQUE(provider_id,external_transaction_id),UNIQUE(provider_id,idempotency_key));CREATE TABLE wallet_ledger_entries(id uuid PRIMARY KEY,wallet_id uuid NOT NULL REFERENCES wallets(id),transaction_id uuid NOT NULL REFERENCES wager_transactions(id),direction varchar(6) NOT NULL CHECK(direction IN('DEBIT','CREDIT')),amount numeric(20,2) NOT NULL CHECK(amount>0),currency varchar(3) NOT NULL,balance_before numeric(20,2) NOT NULL CHECK(balance_before>=0),balance_after numeric(20,2) NOT NULL CHECK(balance_after>=0),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(wallet_id,transaction_id));CREATE TABLE outbox_messages(id uuid PRIMARY KEY,aggregate_id uuid NOT NULL,event_type text NOT NULL,payload jsonb NOT NULL,occurred_at timestamptz NOT NULL DEFAULT now(),attempts integer NOT NULL DEFAULT 0,next_attempt_at timestamptz,published_at timestamptz);CREATE INDEX outbox_due_idx ON outbox_messages(published_at,next_attempt_at);CREATE OR REPLACE FUNCTION deny_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'ledger is append-only';END$$;CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON wallet_ledger_entries FOR EACH ROW EXECUTE FUNCTION deny_ledger_mutation();`,
    );
  }
  async down(q: QueryRunner) {
    await q.query(
      `DROP TABLE IF EXISTS outbox_messages;DROP TABLE IF EXISTS wallet_ledger_entries;DROP TABLE IF EXISTS wager_transactions;DROP TABLE IF EXISTS wallets;DROP FUNCTION IF EXISTS deny_ledger_mutation()`,
    );
  }
}

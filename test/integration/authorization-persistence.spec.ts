import { MikroORM } from '@mikro-orm/postgresql';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import mikroOrmConfig from '../../src/infrastructure/database/mikro-orm.config';
import {
  AuthorizationStore,
  AuthorizationGrant,
} from '../../src/application/authorization/authorization-store';
import { ResourceAuthorization } from '../../src/application/authorization/resource-authorization';
import { WagerProcessingService } from '../../src/application/wager-processing.service';
import { WagerKind } from '../../src/domain/wager-transaction';
import { WalletRepository } from '../../src/application/wallets/wallet-repository';
import { Money } from '../../src/domain/money';
import { ProviderWalletGrant } from '../../src/infrastructure/database/mikro-orm/authorization.entities';

const describeIntegration = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;
const actor = { issuer: 'trusted-admin', subject: 'provisioner', source: 'approved-fixture' };
const principal = {
  issuer: 'https://issuer.example.test',
  subject: 'subject-a',
  providerId: 'provider-a',
  claims: {},
};
const tables = [
  'provider_principal_bindings',
  'provider_wallet_grants',
  'provider_player_grants',
  'operator_grants',
  'authorization_audit',
] as const;

describeIntegration('Persistent authorization with PostgreSQL', () => {
  let orm: MikroORM;
  let store: AuthorizationStore;
  let authorization: ResourceAuthorization;
  let id: string;
  const binding: AuthorizationGrant = { kind: 'binding', ...principal };

  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);
    await orm.getMigrator().up();
  });
  beforeEach(async () => {
    store = new AuthorizationStore(orm.em.fork());
    authorization = new ResourceAuthorization(orm.em.fork());
    id = (
      await new WalletRepository(orm.em.fork()).create(
        'legacy-player',
        Money.from({ amount: '100.00', currency: 'BRL' }),
      )
    ).id;
  });
  afterEach(async () => {
    await orm.em
      .getConnection()
      .execute(
        'truncate table authorization_audit, provider_principal_bindings, provider_player_grants, operator_grants, message_quarantine, inbox_messages, outbox_messages, wallet_ledger_entries, wager_transactions, wallets cascade',
      );
  });
  afterAll(async () => {
    await orm.close(true);
  });

  function grant(): AuthorizationGrant {
    return { kind: 'wallet', providerId: 'provider-a', walletId: id, capability: 'balance.read' };
  }
  const read = (walletId: string) => ({ params: { walletId } });

  it('does not grant legacy resources from OPENING or from a valid JWT alone', async () => {
    await expect(
      authorization.run(
        principal,
        { resource: 'wallet', capability: 'balance.read' },
        read(id),
        async () => true,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await store.grant(binding, actor);
    await expect(
      authorization.run(
        principal,
        { resource: 'wallet', capability: 'balance.read' },
        read(id),
        async () => true,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await orm.em.fork().find(ProviderWalletGrant, {})).toHaveLength(0);
    const rows = await orm.em
      .getConnection()
      .execute(
        'select provider_id, kind, amount::text from wager_transactions where wallet_id = ?',
        [id],
      );
    expect(rows).toEqual([{ provider_id: '__internal__', kind: 'OPENING', amount: '100.00' }]);
  });

  it('persists many providers on one wallet, deduplicates concurrent provisioning and audits transitions', async () => {
    await store.grant(binding, actor);
    await Promise.all(
      Array.from({ length: 8 }, () => new AuthorizationStore(orm.em.fork()).grant(grant(), actor)),
    );
    await store.grant({ ...grant(), providerId: 'provider-b' } as AuthorizationGrant, actor);
    expect(await orm.em.fork().find(ProviderWalletGrant, { walletId: id })).toHaveLength(2);
    const audit = await orm.em
      .getConnection()
      .execute(
        "select decision from authorization_audit where action = 'provider_wallet_grants' order by occurred_at",
      );
    expect(audit).toEqual([{ decision: 'grant' }, { decision: 'grant' }]);
    expect(
      await authorization.run(
        principal,
        { resource: 'wallet', capability: 'balance.read' },
        read(id),
        async () => 'allowed',
      ),
    ).toBe('allowed');
    await store.revoke(grant(), actor);
    await store.revoke(grant(), actor);
    await expect(
      authorization.run(
        principal,
        { resource: 'wallet', capability: 'balance.read' },
        read(id),
        async () => true,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await store.grant(grant(), actor);
    expect(
      await authorization.run(
        principal,
        { resource: 'wallet', capability: 'balance.read' },
        read(id),
        async () => true,
      ),
    ).toBe(true);
    const transitions = await orm.em
      .getConnection()
      .execute(
        "select decision from authorization_audit where action = 'provider_wallet_grants' and provider_id = 'provider-a' order by occurred_at",
      );
    expect(transitions).toEqual([
      { decision: 'grant' },
      { decision: 'revoke' },
      { decision: 'grant' },
    ]);
  });

  it('enforces database uniqueness, foreign keys, capabilities, reserved providers, timestamps and append-only audit', async () => {
    const indexes = await orm.em
      .getConnection()
      .execute<Array<{ indexname: string }>>(
        "select indexname from pg_indexes where schemaname = 'public' and indexname in ('provider_wallet_grants_wallet_idx','authorization_audit_actor_idx','authorization_audit_resource_idx')",
      );
    expect(indexes).toHaveLength(3);
    await store.grant(grant(), actor);
    const insert = `insert into provider_wallet_grants (provider_id, wallet_id, capability, source, actor_issuer, actor_subject) values (?, ?, ?, 'fixture', 'admin', 'subject')`;
    await expect(
      orm.em.getConnection().execute(insert, ['provider-a', id, 'balance.read']),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      orm.em.getConnection().execute(insert, ['other', randomUUID(), 'balance.read']),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      orm.em.getConnection().execute(insert, ['other', id, 'wildcard']),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      orm.em.getConnection().execute(insert, ['__internal__', id, 'balance.read']),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      orm.em
        .getConnection()
        .execute(
          "update provider_wallet_grants set revoked_at = granted_at - interval '1 second' where wallet_id = ?",
          [id],
        ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      orm.em
        .getConnection()
        .execute('delete from provider_wallet_grants where wallet_id = ?', [id]),
    ).rejects.toThrow('revoke authorization grants');
    await expect(
      orm.em.getConnection().execute("update authorization_audit set source = 'tampered'"),
    ).rejects.toThrow('append-only');
    await expect(orm.em.getConnection().execute('delete from authorization_audit')).rejects.toThrow(
      'append-only',
    );
    await expect(
      store.grant(
        {
          kind: 'player',
          providerId: 'provider-a',
          playerId: '',
          currency: 'brl',
          capability: 'wallet.create',
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('serializes revocation behind an already authorized operation and denies the next operation', async () => {
    await store.grant(binding, actor);
    await store.grant(grant(), actor);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const operation = authorization.run(
      principal,
      { resource: 'wallet', capability: 'balance.read' },
      read(id),
      async () => {
        entered();
        await gate;
        return 'completed';
      },
    );
    await ready;
    const db = await orm.em
      .getConnection()
      .execute<Array<{ pid: number }>>('select pg_backend_pid() as pid');
    let revoked = false;
    const revocation = new AuthorizationStore(orm.em.fork()).revoke(grant(), actor).then(() => {
      revoked = true;
    });
    try {
      // Observe an actual PostgreSQL waiter instead of treating a timer as proof of locking.
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
        const rows = await orm.em
          .getConnection()
          .execute<Array<{ blocked: boolean }>>(
            `select exists(select 1 from pg_stat_activity where datname = current_database() and pid <> ? and cardinality(pg_blocking_pids(pid)) > 0) as blocked`,
            [db[0]!.pid],
          );
        blocked = rows[0]!.blocked;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      expect(revoked).toBe(false);
    } finally {
      release();
      await operation;
      await revocation;
    }
    await expect(
      authorization.run(
        principal,
        { resource: 'wallet', capability: 'balance.read' },
        read(id),
        async () => true,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describeIntegration('Authorization migration rollback on a dedicated disposable database', () => {
  it('preserves financial rows, denies unacknowledged data loss and restores backed-up grants after down/up', async () => {
    const name = `authz_migration_${randomUUID().replaceAll('-', '')}`;
    const admin = new Client({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USER ?? 'postgres',
      password: process.env.DB_PASSWORD ?? 'postgres',
      database: process.env.DB_NAME ?? 'jungle',
    });
    await admin.connect();
    await admin.query(`create database "${name}"`);
    const orm = await MikroORM.init({
      ...mikroOrmConfig,
      dbName: name,
      migrations: { ...mikroOrmConfig.migrations, snapshot: false },
    });
    const previous = process.env.AUTHZ_ROLLBACK_BACKUP_CONFIRMED;
    try {
      await orm.getMigrator().up({ to: 'Migration20261116110000' });
      const legacy = await new WalletRepository(orm.em.fork()).create(
        'legacy-before-authz',
        Money.from({ amount: '123.45', currency: 'BRL' }),
      );
      // Historic activity by two providers is evidence, never authorization backfill.
      const processing = new WagerProcessingService(orm.em.fork());
      for (const providerId of ['provider-a', 'provider-b']) {
        expect(
          (
            await processing.process('legacy-key', {
              providerId,
              playerId: 'legacy-before-authz',
              walletId: legacy.id,
              externalTransactionId: 'legacy-external',
              roundId: 'legacy-round',
              gameId: 'legacy-game',
              kind: WagerKind.BET,
              money: { amount: '10.00', currency: 'BRL' },
            })
          ).status,
        ).toBe('PROCESSED');
      }
      async function financialSnapshot() {
        const snapshots: unknown[] = [];
        for (const table of [
          'wallets',
          'wager_transactions',
          'wallet_ledger_entries',
          'inbox_messages',
          'outbox_messages',
          'message_quarantine',
        ]) {
          const result = await orm.em
            .getConnection()
            .execute(
              `select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]') as rows from ${table} t`,
            );
          snapshots.push(result);
        }
        return JSON.stringify(snapshots);
      }
      const original = await financialSnapshot();
      await orm.getMigrator().up();
      expect(await financialSnapshot()).toBe(original);
      expect(await orm.em.fork().find(ProviderWalletGrant, {})).toHaveLength(0);
      const store = new AuthorizationStore(orm.em.fork());
      await store.grant({ kind: 'binding', ...principal }, actor);
      await store.grant(
        {
          kind: 'wallet',
          providerId: 'provider-a',
          walletId: legacy.id,
          capability: 'balance.read',
        },
        actor,
      );
      await store.grant(
        {
          kind: 'wallet',
          providerId: 'provider-b',
          walletId: legacy.id,
          capability: 'wager.submit',
        },
        actor,
      );
      await store.grant(
        {
          kind: 'player',
          providerId: 'provider-a',
          playerId: 'approved-player',
          currency: 'BRL',
          capability: 'wallet.create',
        },
        actor,
      );
      await store.grant(
        {
          kind: 'operator',
          issuer: principal.issuer,
          subject: 'operator',
          action: 'quarantine.resolve',
        },
        actor,
      );
      await store.revoke(
        {
          kind: 'wallet',
          providerId: 'provider-b',
          walletId: legacy.id,
          capability: 'wager.submit',
        },
        actor,
      );
      const backup = new Map<string, Array<Record<string, unknown>>>();
      for (const table of tables)
        backup.set(
          table,
          (
            await orm.em
              .getConnection()
              .execute<Array<{ record: Record<string, unknown> }>>(
                `select to_jsonb(t) as record from ${table} t`,
              )
          ).map((row) => row.record),
        );
      expect(backup.get('provider_wallet_grants')).toHaveLength(2);
      expect(backup.get('authorization_audit')!.length).toBeGreaterThan(0);
      delete process.env.AUTHZ_ROLLBACK_BACKUP_CONFIRMED;
      await expect(
        orm.getMigrator().down({ migrations: ['Migration20261116120000'] }),
      ).rejects.toThrow('verified backup');
      expect(await financialSnapshot()).toBe(original);
      process.env.AUTHZ_ROLLBACK_BACKUP_CONFIRMED = '1';
      await orm.getMigrator().down({ migrations: ['Migration20261116120000'] });
      expect(await financialSnapshot()).toBe(original);
      const absent = await orm.em
        .getConnection()
        .execute("select to_regclass('provider_wallet_grants') as table_name");
      expect(absent).toEqual([{ table_name: null }]);
      await expect(
        new ResourceAuthorization(orm.em.fork()).run(
          principal,
          { resource: 'wallet', capability: 'balance.read' },
          { params: { walletId: legacy.id } },
          async () => true,
        ),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      await orm.getMigrator().up();
      // Restore approved records verbatim; triggers append additional restoration provenance.
      for (const table of tables) {
        for (const row of backup.get(table)!) {
          const columns = Object.keys(row);
          await orm.em
            .getConnection()
            .execute(
              `insert into ${table} (${columns.join(',')}) values (${columns.map(() => '?').join(',')})`,
              Object.values(row),
            );
        }
      }
      for (const table of tables.filter((table) => table !== 'authorization_audit')) {
        const rows = await orm.em
          .getConnection()
          .execute<Array<{ record: Record<string, unknown> }>>(
            `select to_jsonb(t) as record from ${table} t`,
          );
        const actual = rows.map((row) => JSON.stringify(row.record)).sort();
        expect(actual).toEqual(
          backup
            .get(table)!
            .map((row) => JSON.stringify(row))
            .sort(),
        );
      }
      const restored = await orm.em.fork().find(ProviderWalletGrant, { walletId: legacy.id });
      expect(restored).toHaveLength(2);
      const auth = new ResourceAuthorization(orm.em.fork());
      expect(
        await auth.run(
          principal,
          { resource: 'wallet', capability: 'balance.read' },
          { params: { walletId: legacy.id } },
          async () => true,
        ),
      ).toBe(true);
      expect(await financialSnapshot()).toBe(original);
      const audits = await orm.em.getConnection().execute('select id from authorization_audit');
      for (const entry of backup.get('authorization_audit')!)
        expect(audits).toContainEqual({ id: entry.id });
    } finally {
      if (previous === undefined) delete process.env.AUTHZ_ROLLBACK_BACKUP_CONFIRMED;
      else process.env.AUTHZ_ROLLBACK_BACKUP_CONFIRMED = previous;
      await orm.close(true);
      await admin.query(`drop database "${name}"`);
      await admin.end();
    }
  }, 30000);
});

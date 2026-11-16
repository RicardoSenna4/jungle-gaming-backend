import { Client } from 'pg';
import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import config from '../../src/infrastructure/database/mikro-orm.config';
import { AuthorizationStore } from '../../src/application/authorization/authorization-store';

const describeIntegration = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;
describeIntegration('Quarantine migration preservation and guarded rollback', () => {
  it('preserves legacy dispositions and audit while verifying up/down/up', async () => {
    const name = `quarantine_migration_${randomUUID().replaceAll('-', '')}`;
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
      ...config,
      dbName: name,
      migrations: { ...config.migrations, snapshot: false },
    });
    const previous = process.env.QUARANTINE_ROLLBACK_BACKUP_CONFIRMED;
    try {
      await orm.getMigrator().up({ to: 'Migration20261116120000' });
      for (const status of ['OPEN', 'RESOLVED', 'RELEASED'])
        await orm.em
          .getConnection()
          .execute(
            'insert into message_quarantine (consumer_name,message_id,reason,raw_payload,status) values (?,?,?,?,?)',
            ['legacy', status, 'legacy reason', 'preserved raw', status],
          );
      const snapshot = () =>
        orm.em
          .getConnection()
          .execute(
            'select jsonb_agg(to_jsonb(q) order by message_id) as rows from message_quarantine q',
          );
      const original = JSON.stringify(await snapshot());
      await orm.getMigrator().up();
      expect(JSON.stringify(await snapshot())).toBe(original);
      await new AuthorizationStore(orm.em.fork()).grant(
        { kind: 'operator', issuer: 'trusted', subject: 'operator', action: 'quarantine.redrive' },
        { issuer: 'trusted-admin', subject: 'admin', source: 'explicit-test-change' },
      );
      const backup = await orm.em
        .getConnection()
        .execute('select to_jsonb(g) as record from operator_grants g');
      delete process.env.QUARANTINE_ROLLBACK_BACKUP_CONFIRMED;
      await expect(
        orm.getMigrator().down({ migrations: ['Migration20261116130000'] }),
      ).rejects.toThrow('backup required');
      process.env.QUARANTINE_ROLLBACK_BACKUP_CONFIRMED = '1';
      await orm.em
        .getConnection()
        .execute("update message_quarantine set status = 'REDRIVING' where message_id = 'OPEN'");
      await expect(
        orm.getMigrator().down({ migrations: ['Migration20261116130000'] }),
      ).rejects.toThrow('recover active redrives');
      await orm.em
        .getConnection()
        .execute("update message_quarantine set status = 'OPEN' where message_id = 'OPEN'");
      await orm.getMigrator().down({ migrations: ['Migration20261116130000'] });
      expect(JSON.stringify(await snapshot())).toBe(original);
      expect(
        await orm.em
          .getConnection()
          .execute("select id from authorization_audit where action = 'operator_grants'"),
      ).toHaveLength(1);
      await orm.getMigrator().up();
      const row = backup[0].record as Record<string, unknown>;
      const columns = Object.keys(row);
      await orm.em
        .getConnection()
        .execute(
          `insert into operator_grants (${columns.join(',')}) values (${columns.map(() => '?').join(',')})`,
          Object.values(row),
        );
      expect(
        await orm.em.getConnection().execute('select to_jsonb(g) as record from operator_grants g'),
      ).toEqual(backup);
      expect(JSON.stringify(await snapshot())).toBe(original);
    } finally {
      if (previous === undefined) delete process.env.QUARANTINE_ROLLBACK_BACKUP_CONFIRMED;
      else process.env.QUARANTINE_ROLLBACK_BACKUP_CONFIRMED = previous;
      await orm.close(true);
      await admin.query(`drop database "${name}"`);
      await admin.end();
    }
  }, 30000);
});

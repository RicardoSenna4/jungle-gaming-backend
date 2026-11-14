import { Migration } from '@mikro-orm/migrations';

/** Foundation-only metadata. Financial tables belong to the domain/SQL phase. */
export class Migration20261113140000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create table if not exists service_metadata (key text primary key, value text not null);`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists service_metadata;`);
  }
}

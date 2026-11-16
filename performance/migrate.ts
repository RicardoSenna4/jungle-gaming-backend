import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/infrastructure/database/mikro-orm.config';
if (process.env.DB_NAME !== 'jungle_load_test' || process.env.DB_HOST !== 'postgres')
  throw new Error('Disposable performance database required');
const orm = await MikroORM.init({
  ...config,
  migrations: { ...config.migrations, snapshot: false },
});
try {
  await orm.getMigrator().up();
} finally {
  await orm.close(true);
}

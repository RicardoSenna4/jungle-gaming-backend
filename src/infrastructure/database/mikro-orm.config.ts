import {
  QuarantineRedriveAttempt,
  QuarantineOperationEvent,
} from './mikro-orm/quarantine-redrive.entities';
import { authorizationEntities } from './mikro-orm/authorization.entities';
import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { ServiceMetadataEntity } from './entities/service-metadata.entity';
import { QuarantineOrmEntity } from './mikro-orm/quarantine.entity';
import {
  InboxOrmEntity,
  LedgerOrmEntity,
  OutboxOrmEntity,
  WagerTransactionOrmEntity,
  WalletOrmEntity,
} from './mikro-orm/entities';

export default defineConfig({
  driverOptions: {
    connection: {
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    },
  },
  dbName: process.env.DB_NAME ?? 'jungle',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number.parseInt(process.env.DB_PORT ?? '5432', 10),
  user: process.env.DB_USER ?? 'postgres',
  password: process.env.DB_PASSWORD ?? 'postgres',
  entities: [
    QuarantineRedriveAttempt,
    QuarantineOperationEvent,
    ...authorizationEntities,
    ServiceMetadataEntity,
    WalletOrmEntity,
    WagerTransactionOrmEntity,
    LedgerOrmEntity,
    InboxOrmEntity,
    OutboxOrmEntity,
    QuarantineOrmEntity,
  ],
  migrations: {
    path: './dist/infrastructure/database/migrations',
    pathTs: './src/infrastructure/database/migrations',
    tableName: 'mikro_orm_migrations',
    transactional: true,
  },
  extensions: [Migrator],
  debug: process.env.NODE_ENV === 'development' && process.env.DB_DEBUG === 'true',
});

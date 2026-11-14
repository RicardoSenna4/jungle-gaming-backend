import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { WalletEntity, WagerTransactionEntity, LedgerEntity, OutboxEntity } from './entities';
import { InitialSchema1731500000000 } from './typeorm-migrations/1731500000000-InitialSchema';
export const AppDataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/jungle',
  entities: [WalletEntity, WagerTransactionEntity, LedgerEntity, OutboxEntity],
  migrations: [InitialSchema1731500000000],
  synchronize: false,
});

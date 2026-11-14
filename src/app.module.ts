import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { AppController } from './interfaces/http/app.controller';
import { WagerProcessingService } from './application/wager-processing.service';
import { WalletRepository } from './application/wallets/wallet-repository';
import { WalletService } from './application/wallets/wallet-service';
import { WalletController } from './interfaces/http/wallet.controller';
import mikroOrmConfig from './infrastructure/database/mikro-orm.config';
import { PendingReferenceWorker } from './infrastructure/workers/pending-reference.worker';
import { WagerTransactionConsumer } from './infrastructure/workers/wager-transaction.consumer';
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), MikroOrmModule.forRoot(mikroOrmConfig)],
  controllers: [AppController, WalletController],
  providers: [
    WagerProcessingService,
    WalletRepository,
    WalletService,
    PendingReferenceWorker,
    WagerTransactionConsumer,
  ],
})
export class AppModule {}

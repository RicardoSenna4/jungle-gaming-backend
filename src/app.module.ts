import { QuarantineManagementService } from './application/quarantine/quarantine-management.service';
import { MetricsAccessGuard } from './interfaces/http/metrics-access.guard';
import { AdministrativeClaimsPolicy } from './application/authorization/administrative-claims-policy';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ResourceAuthorizationInterceptor } from './interfaces/http/resource-authorization.interceptor';
import { ResourceAuthorization } from './application/authorization/resource-authorization';
import { AuthorizationStore } from './application/authorization/authorization-store';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { AppController } from './interfaces/http/app.controller';
import { ChallengeProviderIdentityGuard } from './interfaces/http/provider-identity.guard';
import { WagerProcessingService } from './application/wager-processing.service';
import { WalletRepository } from './application/wallets/wallet-repository';
import { WalletService } from './application/wallets/wallet-service';
import { WalletController } from './interfaces/http/wallet.controller';
import mikroOrmConfig from './infrastructure/database/mikro-orm.config';
import { PendingReferenceWorker } from './infrastructure/workers/pending-reference.worker';
import { WagerTransactionConsumer } from './infrastructure/workers/wager-transaction.consumer';
import { OutboxPublisherWorker } from './infrastructure/workers/outbox-publisher.worker';
import { SqsInfrastructureClient } from './infrastructure/workers/sqs-infrastructure.client';
import { HealthService } from './infrastructure/telemetry/health.service';
import { MetricsService } from './infrastructure/telemetry/metrics.service';
import { QuarantineOrmEntity } from './infrastructure/database/mikro-orm/quarantine.entity';
import { OidcJwtVerifier } from './interfaces/http/oidc-jwt.verifier';
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MikroOrmModule.forRoot(mikroOrmConfig),
    MikroOrmModule.forFeature([QuarantineOrmEntity]),
  ],
  controllers: [AppController, WalletController],
  providers: [
    QuarantineManagementService,
    AdministrativeClaimsPolicy,
    MetricsAccessGuard,
    AuthorizationStore,
    ResourceAuthorization,
    { provide: APP_INTERCEPTOR, useClass: ResourceAuthorizationInterceptor },
    WagerProcessingService,
    WalletRepository,
    WalletService,
    PendingReferenceWorker,
    WagerTransactionConsumer,
    OutboxPublisherWorker,
    SqsInfrastructureClient,
    HealthService,
    MetricsService,
    OidcJwtVerifier,
    ChallengeProviderIdentityGuard,
  ],
})
export class AppModule {}

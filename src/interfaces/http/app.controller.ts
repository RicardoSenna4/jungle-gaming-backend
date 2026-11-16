import { QuarantineManagementService } from '../../application/quarantine/quarantine-management.service';
import type { AuthenticatedRequest } from './provider-identity.guard';
import { MetricsAccess } from './metrics-access.guard';
import { AuthorizeResource, PublicResource } from './resource-authorization.interceptor';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  Header,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  FinancialProcessingError,
  SubmitInput,
  WagerProcessingService,
} from '../../application/wager-processing.service';
import { HealthService } from '../../infrastructure/telemetry/health.service';
import { MetricsService } from '../../infrastructure/telemetry/metrics.service';
import { SubmitWagerRequestDto } from './dtos';

@Controller()
export class AppController {
  private readonly logger = new Logger(AppController.name);

  constructor(
    private readonly service: WagerProcessingService,
    private readonly health: HealthService,
    private readonly metrics: MetricsService,
    private readonly quarantineManagement: QuarantineManagementService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('wagering/transactions')
  @AuthorizeResource({ resource: 'wallet', capability: 'wager.submit', parameter: 'body' })
  submit(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: SubmitWagerRequestDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!key) throw new BadRequestException({ errorCode: 'IDEMPOTENCY_KEY_REQUIRED' });
    const startedAt = Date.now();
    return this.service
      .process(key, body as SubmitInput)
      .then((result) => {
        this.metrics.increment('wager_transactions_total', {
          source: 'http',
          kind: String(body.kind).toLowerCase(),
          status: result.status.toLowerCase(),
        });
        this.logger.log(
          JSON.stringify({
            event: 'wager_http_processed',
            correlationId: body.externalTransactionId,
            transactionId: result.transactionId,
            walletId: body.walletId,
            providerId: body.providerId,
            status: result.status,
            idempotentReplay: result.idempotentReplay,
          }),
        );
        if (result.status === 'PENDING_REFERENCE') response.status(HttpStatus.ACCEPTED);
        if (result.status === 'REJECTED') {
          throw new UnprocessableEntityException(result);
        }
        return result;
      })
      .catch((error: unknown) => {
        if (!(error instanceof FinancialProcessingError)) throw error;
        this.metrics.increment('wager_request_errors_total', { source: 'http', code: error.code });
        if (error.httpStatus === 409) throw new ConflictException({ errorCode: error.code });
        if (error.httpStatus === 422)
          throw new UnprocessableEntityException({ errorCode: error.code });
        if (error.httpStatus === 404) throw new NotFoundException({ errorCode: error.code });
        if (error.httpStatus === 503) {
          throw new ServiceUnavailableException({ errorCode: error.code, retryable: true });
        }
        throw new BadRequestException({ errorCode: error.code });
      })
      .finally(() => {
        this.metrics.observe(
          'wager_processing_duration_seconds',
          (Date.now() - startedAt) / 1_000,
          { source: 'http' },
        );
      });
  }

  @Get('wagering/transactions/:transactionId')
  @AuthorizeResource({ resource: 'transaction' })
  async getTransaction(@Param('transactionId') transactionId: string) {
    const transaction = await this.service.findTransactionById(transactionId);
    if (!transaction) throw new NotFoundException({ errorCode: 'TRANSACTION_NOT_FOUND' });
    return transaction;
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  @AuthorizeResource({ resource: 'transaction', external: true })
  async getProviderTransaction(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    const transaction = await this.service.findProviderTransaction(
      providerId,
      externalTransactionId,
    );
    if (!transaction) throw new NotFoundException({ errorCode: 'TRANSACTION_NOT_FOUND' });
    return transaction;
  }

  @Get('health/live')
  @PublicResource()
  live() {
    return { status: 'ok' };
  }

  @Get('health/ready')
  @PublicResource()
  async ready() {
    const result = await this.health.readiness();
    if (result.status !== 'ok') throw new ServiceUnavailableException(result);
    return result;
  }

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @MetricsAccess()
  metricsEndpoint(): string {
    return this.metrics.renderPrometheus();
  }

  @Get('operations/quarantine')
  @AuthorizeResource({ resource: 'operator', capability: 'quarantine.read' })
  quarantine(@Headers('x-limit') rawLimit?: string) {
    const limit = rawLimit && /^\d+$/.test(rawLimit) ? Number(rawLimit) : 100;
    return this.service.listQuarantine(limit);
  }

  @Get('operations/quarantine/page')
  @AuthorizeResource({ resource: 'operator', capability: 'quarantine.read' })
  quarantinePage(
    @Query()
    filters: {
      status?: string;
      consumer?: string;
      reason?: string;
      limit?: string;
      cursor?: string;
    },
  ) {
    return this.quarantineManagement.page(filters);
  }

  @Get('operations/quarantine/:consumerName/:messageId/redrives')
  @AuthorizeResource({ resource: 'operator', capability: 'quarantine.read' })
  redriveHistory(@Param('consumerName') consumer: string, @Param('messageId') message: string) {
    return this.quarantineManagement.history(consumer, message);
  }

  @Post('operations/quarantine/:consumerName/:messageId/redrive')
  @AuthorizeResource({ resource: 'operator', capability: 'quarantine.redrive' })
  redrive(
    @Param('consumerName') consumer: string,
    @Param('messageId') message: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: { justification?: string },
    @Req() request: AuthenticatedRequest,
  ) {
    return this.quarantineManagement.redrive(
      consumer,
      message,
      key,
      body?.justification,
      request.principal,
    );
  }

  @Post('operations/quarantine/:consumerName/:messageId/resolve')
  @AuthorizeResource({ resource: 'operator', capability: 'quarantine.resolve' })
  async resolveQuarantine(
    @Param('consumerName') consumerName: string,
    @Param('messageId') messageId: string,
    @Body() body: { note?: string },
    @Req() request: AuthenticatedRequest,
  ) {
    return this.quarantineManagement.resolve(
      consumerName,
      messageId,
      body?.note,
      request.principal,
    );
  }
}

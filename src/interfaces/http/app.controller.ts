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
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('wagering/transactions')
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
  async getTransaction(@Param('transactionId') transactionId: string) {
    const transaction = await this.service.findTransactionById(transactionId);
    if (!transaction) throw new NotFoundException({ errorCode: 'TRANSACTION_NOT_FOUND' });
    return transaction;
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
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
  live() {
    return { status: 'ok' };
  }

  @Get('health/ready')
  async ready() {
    const result = await this.health.readiness();
    if (result.status !== 'ok') throw new ServiceUnavailableException(result);
    return result;
  }

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  metricsEndpoint(): string {
    return this.metrics.renderPrometheus();
  }
}

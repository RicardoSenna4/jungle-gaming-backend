import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
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
@Controller()
export class AppController {
  constructor(private readonly service: WagerProcessingService) {}
  @HttpCode(HttpStatus.OK)
  @Post('wagering/transactions')
  submit(
    @Headers('idempotency-key') key: string | undefined,
    @Body() b: SubmitInput,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!key) throw new BadRequestException({ errorCode: 'IDEMPOTENCY_KEY_REQUIRED' });
    return this.service
      .process(key, b)
      .then((result) => {
        if (result.status === 'PENDING_REFERENCE') response.status(HttpStatus.ACCEPTED);
        if (result.status === 'REJECTED' && !result.idempotentReplay) {
          throw new UnprocessableEntityException(result);
        }
        return result;
      })
      .catch((error: unknown) => {
        if (!(error instanceof FinancialProcessingError)) throw error;
        if (error.httpStatus === 409) throw new ConflictException({ errorCode: error.code });
        if (error.httpStatus === 422)
          throw new UnprocessableEntityException({ errorCode: error.code });
        if (error.httpStatus === 404) throw new NotFoundException({ errorCode: error.code });
        if (error.httpStatus === 503) {
          throw new ServiceUnavailableException({ errorCode: error.code, retryable: true });
        }
        throw new BadRequestException({ errorCode: error.code });
      });
  }
  @Get('health/live') live() {
    return { status: 'ok' };
  }
  @Get('health/ready') ready() {
    return { status: 'ok' };
  }
}

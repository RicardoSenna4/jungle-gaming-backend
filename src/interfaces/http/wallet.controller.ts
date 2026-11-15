import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Query,
  ParseUUIDPipe,
} from '@nestjs/common';
import { MetricsService } from '../../infrastructure/telemetry/metrics.service';
import { WalletService } from '../../application/wallets/wallet-service';
import { CreateWalletRequestDto } from './dtos';

@Controller('wallets')
export class WalletController {
  private readonly logger = new Logger(WalletController.name);

  constructor(private readonly wallets: WalletService, private readonly metrics: MetricsService) {}

  @Post()
  create(@Body() body: CreateWalletRequestDto) {
    return this.wallets.createWallet(body.playerId, body.initialBalance);
  }

  @Get(':walletId')
  get(@Param('walletId', new ParseUUIDPipe({ version: '4' })) walletId: string) {
    return this.wallets.getWallet(walletId);
  }

  @Get(':walletId/ledger')
  ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') rawLimit?: string,
  ) {
    if (rawLimit !== undefined && !/^\d+$/.test(rawLimit)) {
      throw new BadRequestException('INVALID_LEDGER_LIMIT');
    }
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    return this.wallets.getLedger(walletId, limit, cursor);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconcile(@Param('walletId') walletId: string) {
    const result = await this.wallets.reconcile(walletId);
    this.metrics.increment('wallet_reconciliations_total', { consistent: String(result.consistent) });
    if (!result.consistent) {
      this.metrics.increment('wallet_reconciliation_mismatches_total');
      this.logger.warn(
        JSON.stringify({
          event: 'wallet_reconciliation_mismatch',
          walletId,
          checkedEntries: result.checkedEntries,
        }),
      );
    }
    return result;
  }
}

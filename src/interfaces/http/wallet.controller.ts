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
} from '@nestjs/common';
import { WalletService } from '../../application/wallets/wallet-service';
import { CreateWalletRequestDto } from './dtos';

@Controller('wallets')
export class WalletController {
  private readonly logger = new Logger(WalletController.name);

  constructor(private readonly wallets: WalletService) {}

  @Post()
  create(@Body() body: CreateWalletRequestDto) {
    return this.wallets.createWallet(body.playerId, body.initialBalance);
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string) {
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
    if (!result.consistent) {
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

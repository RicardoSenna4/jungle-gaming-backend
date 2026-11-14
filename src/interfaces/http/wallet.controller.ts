import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { WalletService } from '../../application/wallets/wallet-service';

interface CreateWalletBody {
  playerId: string;
  initialBalance: { amount: string; currency: string };
}

@Controller('wallets')
export class WalletController {
  constructor(private readonly wallets: WalletService) {}

  @Post()
  create(@Body() body: CreateWalletBody) {
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
    const limit = rawLimit === undefined ? 50 : Number.parseInt(rawLimit, 10);
    return this.wallets.getLedger(walletId, limit, cursor);
  }
}

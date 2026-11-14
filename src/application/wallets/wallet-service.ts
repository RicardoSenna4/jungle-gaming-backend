import { Injectable } from '@nestjs/common';
import { Money } from '../../domain/money';
import { LedgerPage, WalletReconciliation, WalletRepository } from './wallet-repository';

@Injectable()
export class WalletService {
  constructor(private readonly wallets: WalletRepository) {}

  createWallet(playerId: string, initialBalance: { amount: string; currency: string }) {
    return this.wallets.create(playerId, Money.from(initialBalance));
  }

  getWallet(walletId: string) {
    return this.wallets.findById(walletId);
  }

  getLedger(walletId: string, limit = 50, cursor?: string): Promise<LedgerPage> {
    return this.wallets.findLedger(walletId, limit, cursor);
  }

  reconcile(walletId: string): Promise<WalletReconciliation> {
    return this.wallets.reconcile(walletId);
  }
}

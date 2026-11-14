import { EntityManager } from '@mikro-orm/postgresql';
import { WalletRepository } from '../../src/application/wallets/wallet-repository';

describe('wallet reconciliation', () => {
  it('reconstructs the balance from immutable ledger entries using decimal strings', async () => {
    const em = {
      getConnection: () => ({
        execute: async () => [
          {
            wallet_id: 'wallet-1',
            currency: 'BRL',
            stored_balance: '100.00',
            calculated_balance: '100.00',
            checked_entries: '3',
          },
        ],
      }),
    } as unknown as EntityManager;
    const repository = new WalletRepository(em);

    await expect(repository.reconcile('wallet-1')).resolves.toEqual({
      walletId: 'wallet-1',
      storedBalance: { amount: '100.00', currency: 'BRL' },
      calculatedBalance: { amount: '100.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 3,
    });
  });

  it('reports differences and never applies an automatic correction', async () => {
    const em = {
      getConnection: () => ({
        execute: async () => [
          {
            wallet_id: 'wallet-2',
            currency: 'BRL',
            stored_balance: '12.50',
            calculated_balance: '10.00',
            checked_entries: '2',
          },
        ],
      }),
    } as unknown as EntityManager;
    const repository = new WalletRepository(em);

    await expect(repository.reconcile('wallet-2')).resolves.toMatchObject({
      difference: { amount: '2.50', currency: 'BRL' },
      consistent: false,
      checkedEntries: 2,
    });
  });
});

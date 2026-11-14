import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
describe('Wallet', () => {
  it('starts at version one and increments only on movement', () => {
    const w = Wallet.open({
      id: 'w',
      playerId: 'p',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    expect(w.version).toBe(1);
    w.debit(Money.from({ amount: '25.00', currency: 'BRL' }));
    expect(w.balance.toString()).toBe('75.00');
    expect(w.version).toBe(2);
  });
  it('rejects insufficient debit without changing balance', () => {
    const w = Wallet.open({ id: 'w', playerId: 'p', initialBalance: Money.zero('BRL') });
    expect(() => w.debit(Money.from({ amount: '1.00', currency: 'BRL' }))).toThrow(
      'INSUFFICIENT_FUNDS',
    );
    expect(w.balance.toString()).toBe('0.00');
  });
});

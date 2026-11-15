import { Money } from '../../src/domain/money';

describe('Money', () => {
  it('preserves exact decimal strings and is immutable', () => {
    const a = Money.from({ amount: '10.10', currency: 'BRL' });
    const b = a.add(Money.from({ amount: '0.20', currency: 'BRL' }));
    expect(a.toJSON()).toEqual({ amount: '10.10', currency: 'BRL' });
    expect(b.toString()).toBe('10.30');
  });
  it('rejects non-canonical external amounts', () => {
    for (const amount of ['10', '10.1', '10.001', '1e2', 'NaN', '-1.00', ''])
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow();
  });
  it('supports negative intermediate values without accepting negative input', () => {
    expect(
      Money.from({ amount: '1.00', currency: 'BRL' })
        .subtract(Money.from({ amount: '2.00', currency: 'BRL' }))
        .toString(),
    ).toBe('-1.00');
  });
  it('preserves 20-digit decimal arithmetic without binary floating point or silent rounding', () => {
    const value = Money.from({ amount: '999999999999999999.99', currency: 'BRL' });
    expect(value.subtract(Money.from({ amount: '0.01', currency: 'BRL' })).toString())
      .toBe('999999999999999999.98');
  });
  it('rejects mixed currencies', () =>
    expect(() =>
      Money.from({ amount: '1.00', currency: 'BRL' }).add(
        Money.from({ amount: '1.00', currency: 'USD' }),
      ),
    ).toThrow('CURRENCY_MISMATCH'));
});

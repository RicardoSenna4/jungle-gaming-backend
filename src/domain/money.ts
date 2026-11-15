import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';

// Higher than NUMERIC(20,2) to avoid rounding before PostgreSQL overflow checks.
const ExactDecimal = Decimal.clone({ precision: 40 });

export interface MoneyProps {
  amount: string;
  currency: string;
}
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}
  static from(props: MoneyProps): Money {
    if (typeof props.amount !== 'string' || !/^(0|[1-9]\d*)\.\d{2}$/.test(props.amount))
      throw new InvalidMoneyError();
    if (!/^[A-Z]{3}$/.test(props.currency)) throw new InvalidMoneyError('Invalid currency');
    return new Money(new ExactDecimal(props.amount), props.currency);
  }
  static rehydrate(props: MoneyProps): Money {
    return Money.from(props);
  }
  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }
  private static internal(value: Decimal, currency: string): Money {
    if (!/^[A-Z]{3}$/.test(currency)) throw new InvalidMoneyError('Invalid currency');
    return new Money(value, currency);
  }
  private same(other: Money): void {
    if (this.currency !== other.currency) throw new CurrencyMismatchError();
  }
  add(other: Money): Money {
    this.same(other);
    return Money.internal(this.value.plus(other.value), this.currency);
  }
  subtract(other: Money): Money {
    this.same(other);
    return Money.internal(this.value.minus(other.value), this.currency);
  }
  negate(): Money {
    return Money.internal(this.value.negated(), this.currency);
  }
  isZero(): boolean {
    return this.value.isZero();
  }
  isPositive(): boolean {
    return this.value.greaterThan(0);
  }
  isNegative(): boolean {
    return this.value.lessThan(0);
  }
  isLessThan(other: Money): boolean {
    this.same(other);
    return this.value.lessThan(other.value);
  }
  equals(other: Money): boolean {
    this.same(other);
    return this.value.equals(other.value);
  }
  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(2), currency: this.currency };
  }
  toString(): string {
    return this.value.toFixed(2);
  }
}

import { Money } from './money';
export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}
  static open(p: { id: string; playerId: string; initialBalance: Money }): Wallet {
    if (p.initialBalance.isNegative()) throw new Error('NEGATIVE_BALANCE');
    return new Wallet(
      p.id,
      p.playerId,
      p.initialBalance.currency,
      p.initialBalance,
      1,
      new Date(),
      new Date(),
    );
  }
  static rehydrate(s: WalletState): Wallet {
    return new Wallet(s.id, s.playerId, s.currency, s.balance, s.version, s.createdAt, s.updatedAt);
  }
  get balance(): Money {
    return this._balance;
  }
  get version(): number {
    return this._version;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }
  debit(amount: Money): void {
    if (amount.isNegative() || amount.isZero()) throw new Error('INVALID_AMOUNT');
    if (this._balance.isLessThan(amount)) throw new Error('INSUFFICIENT_FUNDS');
    this.change(this._balance.subtract(amount));
  }
  credit(amount: Money): void {
    if (amount.isNegative() || amount.isZero()) throw new Error('INVALID_AMOUNT');
    this.change(this._balance.add(amount));
  }
  private change(next: Money): void {
    this._balance = next;
    this._version++;
    this._updatedAt = new Date();
  }
}

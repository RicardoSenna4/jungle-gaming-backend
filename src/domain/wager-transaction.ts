import { InvalidTransactionStateError } from './errors';
import { FailureCode } from './failure-code';
import { LedgerDirection } from './ledger';
import { Money } from './money';

export { FailureCode } from './failure-code';
export enum WagerKind {
  OPENING = 'OPENING',
  BET = 'BET',
  WIN = 'WIN',
  LOSS = 'LOSS',
  REFUND = 'REFUND',
  ROLLBACK = 'ROLLBACK',
}
export enum WagerStatus {
  PENDING = 'PENDING',
  PENDING_REFERENCE = 'PENDING_REFERENCE',
  PROCESSED = 'PROCESSED',
  REJECTED = 'REJECTED',
  FAILED = 'FAILED',
}
export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    private _status: WagerStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    public readonly createdAt: Date = new Date(),
    private _processedAt?: Date,
  ) {}
  static create = WagerTransaction.createFromProps;
  static createFromProps(p: {
    id: string;
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    payloadHash: string;
    walletId: string;
    playerId: string;
    roundId: string;
    gameId: string;
    kind: WagerKind;
    money: Money;
    referenceExternalTransactionId?: string;
  }): WagerTransaction {
    if (p.kind === WagerKind.OPENING) throw new Error('OPENING_EXTERNAL');
    if (!p.money.isPositive()) throw new Error('INVALID_AMOUNT');
    if (
      (p.kind === WagerKind.REFUND || p.kind === WagerKind.ROLLBACK) &&
      !p.referenceExternalTransactionId
    )
      throw new Error('REFERENCE_REQUIRED');
    return new WagerTransaction(
      p.id,
      p.providerId,
      p.externalTransactionId,
      p.idempotencyKey,
      p.payloadHash,
      p.walletId,
      p.playerId,
      p.roundId,
      p.gameId,
      p.kind,
      p.money,
      p.referenceExternalTransactionId,
      WagerStatus.PENDING,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      new Date(state.createdAt),
      state.processedAt ? new Date(state.processedAt) : undefined,
    );
  }

  get status(): WagerStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt ? new Date(this._processedAt) : undefined;
  }
  isTerminal() {
    return [WagerStatus.PROCESSED, WagerStatus.REJECTED, WagerStatus.FAILED].includes(this._status);
  }
  markProcessed(referenceTransactionId?: string, at = new Date()): void {
    this.assertMutable();
    this._status = WagerStatus.PROCESSED;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
  }
  markPendingReference(): void {
    this.assertMutable();
    this._status = WagerStatus.PENDING_REFERENCE;
  }
  reject(code: FailureCode): void {
    this.assertMutable();
    this._status = WagerStatus.REJECTED;
    this._failureCode = code;
  }
  fail(code: FailureCode): void {
    this.assertMutable();
    this._status = WagerStatus.FAILED;
    this._failureCode = code;
  }

  affectsBalance(): boolean {
    return this.kind !== WagerKind.LOSS;
  }

  requiresReference(): boolean {
    return this.kind === WagerKind.REFUND || this.kind === WagerKind.ROLLBACK;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    if (this.kind === WagerKind.BET) return LedgerDirection.DEBIT;
    if (this.kind === WagerKind.WIN || this.kind === WagerKind.REFUND) {
      return LedgerDirection.CREDIT;
    }
    if (this.kind === WagerKind.ROLLBACK && reference) {
      return reference.ledgerDirectionFor() === LedgerDirection.CREDIT
        ? LedgerDirection.DEBIT
        : LedgerDirection.CREDIT;
    }
    throw new Error('LEDGER_DIRECTION_UNDEFINED');
  }

  private assertMutable(): void {
    if (this.isTerminal()) throw new InvalidTransactionStateError();
  }
}

import { Injectable, Optional } from '@nestjs/common';
import { EnsureRequestContext, LockMode } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { Money } from '../domain/money';
import { Wallet } from '../domain/wallet';
import { WalletLedgerEntry } from '../domain/ledger';
import { WagerTransaction } from '../domain/wager-transaction';
import { FailureCode } from '../domain/failure-code';
import { LedgerDirection } from '../domain/ledger';
import { WagerKind, WagerStatus } from '../domain/wager-transaction';
import { canonicalHash } from './canonical-hash';
import {
  createWagerEvent,
  createWalletBalanceChangedEvent,
  WagerEventType,
} from '../domain/events/event-factory';
import { IntegrationEvent } from '../domain/events/integration-event';
import { MetricsService } from '../infrastructure/telemetry/metrics.service';
import {
  InboxOrmEntity,
  LedgerOrmEntity,
  OutboxOrmEntity,
  WagerTransactionOrmEntity,
  WalletOrmEntity,
} from '../infrastructure/database/mikro-orm/entities';
import { QuarantineOrmEntity } from '../infrastructure/database/mikro-orm/quarantine.entity';

export interface SubmitInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerKind;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export interface ConsumerContext {
  consumerName: string;
  messageId: string;
}

export interface ProcessingResult {
  transactionId: string;
  status: string;
  balance: { amount: string; currency: string };
  idempotentReplay: boolean;
  failureCode?: string;
}

export interface WagerTransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  status: string;
  failureCode?: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  createdAt?: string;
  processedAt?: string;
  response?: Record<string, unknown>;
}

export interface QuarantineView {
  messageId: string;
  consumerName: string;
  reason: string;
  receiveCount: number;
  status: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  resolvedAt?: string;
  resolutionNote?: string;
}

export class FinancialProcessingError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
  ) {
    super(code);
    this.name = 'FinancialProcessingError';
  }
}

export function canonicalWagerPayload(input: Record<string, unknown>): Record<string, unknown> {
  return {
    externalTransactionId: input.externalTransactionId,
    gameId: input.gameId,
    kind: input.kind,
    money: input.money,
    playerId: input.playerId,
    providerId: input.providerId,
    referenceExternalTransactionId: input.referenceExternalTransactionId ?? null,
    roundId: input.roundId,
    walletId: input.walletId,
  };
}

export function wagerPayloadHash(input: Record<string, unknown>): string {
  return canonicalHash(canonicalWagerPayload(input));
}

const PENDING_REFERENCE_MAX_ATTEMPTS = 5;
const PENDING_REFERENCE_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class WagerProcessingService {
  constructor(
    private readonly em: EntityManager,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async findTransactionById(transactionId: string): Promise<WagerTransactionView | null> {
    const transaction = await this.em.findOne(WagerTransactionOrmEntity, { id: transactionId });
    return transaction ? this.toTransactionView(transaction) : null;
  }

  async findProviderTransaction(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionView | null> {
    const transaction = await this.em.findOne(WagerTransactionOrmEntity, {
      providerId,
      externalTransactionId,
    });
    return transaction ? this.toTransactionView(transaction) : null;
  }

  async quarantineMessage(
    consumerName: string,
    messageId: string,
    reason: string,
    rawPayload: string,
    receiveCount: number,
  ): Promise<void> {
    await this.em.transactional(async (tx) => {
      const existing = await tx.findOne(QuarantineOrmEntity, { consumerName, messageId });
      if (existing) {
        existing.reason = reason;
        existing.rawPayload = rawPayload;
        existing.receiveCount = Math.max(existing.receiveCount + 1, receiveCount, 1);
        existing.status = 'OPEN';
        existing.lastSeenAt = new Date();
        existing.resolvedAt = undefined;
        existing.resolutionNote = undefined;
        return;
      }
      tx.persist(
        tx.create(QuarantineOrmEntity, {
          consumerName,
          messageId,
          reason,
          rawPayload,
          receiveCount: Math.max(receiveCount, 1),
          status: 'OPEN',
        }),
      );
    });
    this.metrics?.increment('quarantine_messages_total', { reason });
  }

  async listQuarantine(limit = 100): Promise<QuarantineView[]> {
    const rows = await this.em.find(
      QuarantineOrmEntity,
      {},
      { orderBy: { lastSeenAt: 'desc' }, limit: Math.min(Math.max(limit, 1), 500) },
    );
    return rows.map((row) => this.toQuarantineView(row));
  }

  async resolveQuarantine(
    consumerName: string,
    messageId: string,
    note: string,
  ): Promise<QuarantineView | null> {
    const row = await this.em.findOne(QuarantineOrmEntity, { consumerName, messageId });
    if (!row) return null;
    row.status = 'RESOLVED';
    row.resolvedAt = new Date();
    row.resolutionNote = note;
    await this.em.flush();
    return this.toQuarantineView(row);
  }

  private toQuarantineView(row: QuarantineOrmEntity): QuarantineView {
    return {
      messageId: row.messageId,
      consumerName: row.consumerName,
      reason: row.reason,
      receiveCount: row.receiveCount,
      status: row.status,
      ...(row.firstSeenAt ? { firstSeenAt: row.firstSeenAt.toISOString() } : {}),
      ...(row.lastSeenAt ? { lastSeenAt: row.lastSeenAt.toISOString() } : {}),
      ...(row.resolvedAt ? { resolvedAt: row.resolvedAt.toISOString() } : {}),
      ...(row.resolutionNote ? { resolutionNote: row.resolutionNote } : {}),
    };
  }

  private toTransactionView(transaction: WagerTransactionOrmEntity): WagerTransactionView {
    return {
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      playerId: transaction.playerId,
      walletId: transaction.walletId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      money: { amount: transaction.amount, currency: transaction.currency },
      status: transaction.status,
      ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
      ...(transaction.referenceExternalTransactionId
        ? { referenceExternalTransactionId: transaction.referenceExternalTransactionId }
        : {}),
      ...(transaction.referenceTransactionId
        ? { referenceTransactionId: transaction.referenceTransactionId }
        : {}),
      ...(transaction.createdAt ? { createdAt: transaction.createdAt.toISOString() } : {}),
      ...(transaction.processedAt ? { processedAt: transaction.processedAt.toISOString() } : {}),
      ...(transaction.responseSnapshot ? { response: transaction.responseSnapshot } : {}),
    };
  }

  @EnsureRequestContext((self: WagerProcessingService) => self.em)
  async process(
    idempotencyKey: string,
    input: SubmitInput,
    retryAttempt = 0,
    consumerContext?: ConsumerContext,
  ): Promise<ProcessingResult> {
    this.validateInput(idempotencyKey, input);
    let money: Money;
    try {
      money = Money.from(input.money);
    } catch {
      throw new FinancialProcessingError('INVALID_MONEY', 400);
    }
    if (!money.isPositive()) throw new FinancialProcessingError('INVALID_AMOUNT', 400);
    const payloadHash = wagerPayloadHash(input as unknown as Record<string, unknown>);

    try {
      return await this.em.transactional(async (tx) => {
        await this.claimInbox(tx, consumerContext, payloadHash);
        const transactionRepository = tx.getRepository(WagerTransactionOrmEntity);
        const existing = await transactionRepository.findOne({
          providerId: input.providerId,
          idempotencyKey,
        });
        if (existing) {
          if (existing.payloadHash !== payloadHash) {
            throw new FinancialProcessingError('IDEMPOTENCY_PAYLOAD_CONFLICT', 409);
          }
          if (
            existing.status === WagerStatus.PENDING_REFERENCE &&
            (existing.kind === WagerKind.REFUND || existing.kind === WagerKind.ROLLBACK)
          ) {
            return this.processPendingInTransaction(tx, existing, input, money, consumerContext);
          }
          this.metrics?.increment('wager_idempotent_replays_total');
          return this.finishInbox(tx, consumerContext, {
            ...this.readSnapshot(existing.responseSnapshot),
            idempotentReplay: true,
          });
        }

        const wallet = await this.lockWallet(tx, input, money);
        // A second read AFTER obtaining the wallet lock closes the cross-process
        // check-then-insert race: all operations for a wallet now observe committed
        // transactions from predecessors before attempting an insert.
        const afterLock = await transactionRepository.findOne(
          {
            providerId: input.providerId,
            idempotencyKey,
          },
          { refresh: true },
        );
        if (afterLock) {
          if (afterLock.payloadHash !== payloadHash) {
            throw new FinancialProcessingError('IDEMPOTENCY_PAYLOAD_CONFLICT', 409);
          }
          if (
            afterLock.status === WagerStatus.PENDING_REFERENCE &&
            (afterLock.kind === WagerKind.REFUND || afterLock.kind === WagerKind.ROLLBACK)
          ) {
            return this.processPendingInTransaction(tx, afterLock, input, money, consumerContext);
          }
          this.metrics?.increment('wager_idempotent_replays_total');
          return this.finishInbox(tx, consumerContext, {
            ...this.readSnapshot(afterLock.responseSnapshot),
            idempotentReplay: true,
          });
        }
        const externalAfterLock = await transactionRepository.findOne(
          {
            providerId: input.providerId,
            externalTransactionId: input.externalTransactionId,
          },
          { refresh: true },
        );
        if (externalAfterLock)
          throw new FinancialProcessingError('EXTERNAL_TRANSACTION_EXISTS', 409);
        if (input.kind === WagerKind.REFUND || input.kind === WagerKind.ROLLBACK) {
          const reference = await transactionRepository.findOne({
            providerId: input.providerId,
            externalTransactionId: input.referenceExternalTransactionId,
          });
          if (!reference) {
            return this.persistPendingReference(
              tx,
              input,
              money,
              idempotencyKey,
              payloadHash,
              wallet,
              consumerContext,
            );
          }
          return this.persistResolvedOperation(
            tx,
            input,
            money,
            idempotencyKey,
            payloadHash,
            wallet,
            reference,
            consumerContext,
          );
        }

        return this.persistImmediateOperation(
          tx,
          input,
          money,
          idempotencyKey,
          payloadHash,
          wallet,
          consumerContext,
        );
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        const concurrent = await this.findConcurrentIdempotencyResult(
          input.providerId,
          idempotencyKey,
        );
        if (concurrent) {
          if (concurrent.payloadHash !== payloadHash) {
            throw new FinancialProcessingError('IDEMPOTENCY_PAYLOAD_CONFLICT', 409);
          }
          this.metrics?.increment('wager_idempotent_replays_total');
          return {
            ...this.readSnapshot(concurrent.responseSnapshot),
            idempotentReplay: true,
          };
        }
        if (retryAttempt < 3) {
          this.metrics?.increment('wager_transaction_retries_total', { reason: 'unique_conflict' });
          await this.sleep(10 * (retryAttempt + 1));
          return this.process(idempotencyKey, input, retryAttempt + 1, consumerContext);
        }
        throw new FinancialProcessingError('EXTERNAL_TRANSACTION_EXISTS', 409);
      }
      if (this.isRetryableTransaction(error) && retryAttempt < 3) {
        this.metrics?.increment('wager_transaction_retries_total', { reason: 'serialization' });
        this.metrics?.increment('wager_lock_conflicts_total');
        await this.sleep(10 * (retryAttempt + 1));
        return this.process(idempotencyKey, input, retryAttempt + 1, consumerContext);
      }
      throw error;
    }
  }

  @EnsureRequestContext((self: WagerProcessingService) => self.em)
  async reprocessPendingReference(
    transactionId: string,
    now = new Date(),
  ): Promise<ProcessingResult | null> {
    const pending = await this.em.findOne(WagerTransactionOrmEntity, {
      id: transactionId,
      status: WagerStatus.PENDING_REFERENCE,
    });
    if (!pending || (pending.referenceNextAttemptAt && pending.referenceNextAttemptAt > now))
      return null;
    const input: SubmitInput = {
      providerId: pending.providerId,
      externalTransactionId: pending.externalTransactionId,
      playerId: pending.playerId,
      walletId: pending.walletId,
      roundId: pending.roundId,
      gameId: pending.gameId,
      kind: pending.kind as WagerKind,
      money: { amount: pending.amount, currency: pending.currency },
      referenceExternalTransactionId: pending.referenceExternalTransactionId,
    };
    return this.process(pending.idempotencyKey, input);
  }

  private async claimInbox(
    tx: EntityManager,
    context: ConsumerContext | undefined,
    payloadHash: string,
  ): Promise<void> {
    if (!context) return;
    const inbox = await tx.findOne(InboxOrmEntity, {
      consumerName: context.consumerName,
      messageId: context.messageId,
    });
    if (inbox) {
      if (inbox.payloadHash !== payloadHash) {
        throw new FinancialProcessingError('INBOX_PAYLOAD_CONFLICT', 409);
      }
      if (inbox.processedAt) return;
      return;
    }
    tx.persist(
      tx.create(InboxOrmEntity, {
        consumerName: context.consumerName,
        messageId: context.messageId,
        payloadHash,
        receivedAt: new Date(),
      }),
    );
    await tx.flush();
  }

  private async lockWallet(
    tx: EntityManager,
    input: SubmitInput,
    money: Money,
  ): Promise<WalletOrmEntity> {
    const wallet = await tx.findOne(
      WalletOrmEntity,
      { id: input.walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    if (!wallet) throw new FinancialProcessingError('WALLET_NOT_FOUND', 404);
    if (wallet.playerId !== input.playerId || wallet.currency !== money.currency) {
      throw new FinancialProcessingError('WALLET_CONTEXT_MISMATCH', 422);
    }
    return wallet;
  }

  private persistPendingReference(
    tx: EntityManager,
    input: SubmitInput,
    money: Money,
    idempotencyKey: string,
    payloadHash: string,
    wallet: WalletOrmEntity,
    context: ConsumerContext | undefined,
  ): ProcessingResult {
    const transactionId = randomUUID();
    const now = new Date();
    const response: ProcessingResult = {
      transactionId,
      status: WagerStatus.PENDING_REFERENCE,
      balance: { amount: wallet.balance, currency: wallet.currency },
      idempotentReplay: false,
    };
    const transaction = tx.create(WagerTransactionOrmEntity, {
      id: transactionId,
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey,
      payloadHash,
      walletId: wallet.id,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      amount: money.toString(),
      currency: money.currency,
      status: WagerStatus.PENDING_REFERENCE,
      referenceExternalTransactionId: input.referenceExternalTransactionId,
      responseSnapshot: response as unknown as Record<string, unknown>,
      referenceAttempts: 0,
      referenceNextAttemptAt: new Date(now.getTime() + 1_000),
      referenceExpiresAt: new Date(now.getTime() + PENDING_REFERENCE_TTL_MS),
    });
    tx.persist(transaction);
    this.enqueueWagerEvent(tx, transactionId, 'WagerTransactionPendingReference', input, response);
    return this.finishInbox(tx, context, response);
  }

  private persistImmediateOperation(
    tx: EntityManager,
    input: SubmitInput,
    money: Money,
    idempotencyKey: string,
    payloadHash: string,
    wallet: WalletOrmEntity,
    context: ConsumerContext | undefined,
  ): Promise<ProcessingResult> {
    const before = Money.from({ amount: wallet.balance, currency: wallet.currency });
    let after = before;
    let direction: LedgerDirection | undefined;
    let status: WagerStatus = WagerStatus.PROCESSED;
    let failureCode: string | undefined;
    if (input.kind === WagerKind.BET) {
      if (before.isLessThan(money)) {
        status = WagerStatus.REJECTED;
        failureCode = 'INSUFFICIENT_FUNDS';
      } else {
        after = before.subtract(money);
        direction = LedgerDirection.DEBIT;
      }
    } else if (input.kind === WagerKind.WIN) {
      after = before.add(money);
      direction = LedgerDirection.CREDIT;
    }
    return this.persistOperation(
      tx,
      input,
      money,
      idempotencyKey,
      payloadHash,
      wallet,
      undefined,
      before,
      after,
      direction,
      status,
      failureCode,
      context,
    );
  }

  private async persistResolvedOperation(
    tx: EntityManager,
    input: SubmitInput,
    money: Money,
    idempotencyKey: string,
    payloadHash: string,
    wallet: WalletOrmEntity,
    reference: WagerTransactionOrmEntity,
    context: ConsumerContext | undefined,
    existingTransaction?: WagerTransactionOrmEntity,
  ): Promise<ProcessingResult> {
    if (
      reference.playerId !== input.playerId ||
      reference.walletId !== input.walletId ||
      reference.currency !== money.currency ||
      reference.roundId !== input.roundId
    ) {
      return this.persistRejectedOperation(
        tx,
        input,
        money,
        idempotencyKey,
        payloadHash,
        wallet,
        'REFERENCE_CONTEXT_MISMATCH',
        context,
        existingTransaction,
      );
    }
    if (reference.status !== WagerStatus.PROCESSED) {
      return this.persistRejectedOperation(
        tx,
        input,
        money,
        idempotencyKey,
        payloadHash,
        wallet,
        'REFERENCE_NOT_PROCESSED',
        context,
        existingTransaction,
      );
    }
    if (input.kind === WagerKind.REFUND && reference.kind !== WagerKind.BET) {
      return this.persistRejectedOperation(
        tx,
        input,
        money,
        idempotencyKey,
        payloadHash,
        wallet,
        'INVALID_REFERENCE_KIND',
        context,
        existingTransaction,
      );
    }
    if (
      input.kind === WagerKind.ROLLBACK &&
      ![WagerKind.BET, WagerKind.WIN, WagerKind.REFUND].includes(reference.kind as WagerKind)
    ) {
      return this.persistRejectedOperation(
        tx,
        input,
        money,
        idempotencyKey,
        payloadHash,
        wallet,
        'INVALID_REFERENCE_KIND',
        context,
        existingTransaction,
      );
    }
    if (reference.amount !== money.toString()) {
      return this.persistRejectedOperation(
        tx,
        input,
        money,
        idempotencyKey,
        payloadHash,
        wallet,
        'AMOUNT_MISMATCH',
        context,
        existingTransaction,
      );
    }
    const existingReversal = await tx.findOne(WagerTransactionOrmEntity, {
      referenceTransactionId: reference.id,
    });
    if (existingReversal) {
      return this.persistRejectedOperation(
        tx,
        input,
        money,
        idempotencyKey,
        payloadHash,
        wallet,
        'REVERSAL_ALREADY_APPLIED',
        context,
        existingTransaction,
      );
    }
    const before = Money.from({ amount: wallet.balance, currency: wallet.currency });
    const referenceDirection =
      reference.kind === WagerKind.BET ? LedgerDirection.DEBIT : LedgerDirection.CREDIT;
    const direction =
      input.kind === WagerKind.REFUND
        ? LedgerDirection.CREDIT
        : referenceDirection === LedgerDirection.CREDIT
          ? LedgerDirection.DEBIT
          : LedgerDirection.CREDIT;
    if (direction === LedgerDirection.DEBIT && before.isLessThan(money)) {
      return this.persistRejectedOperation(
        tx,
        input,
        money,
        idempotencyKey,
        payloadHash,
        wallet,
        'REVERSAL_INSUFFICIENT_FUNDS',
        context,
        existingTransaction,
      );
    }
    const after = direction === LedgerDirection.DEBIT ? before.subtract(money) : before.add(money);
    return this.persistOperation(
      tx,
      input,
      money,
      idempotencyKey,
      payloadHash,
      wallet,
      reference.id,
      before,
      after,
      direction,
      WagerStatus.PROCESSED,
      undefined,
      context,
      existingTransaction,
    );
  }

  private async processPendingInTransaction(
    tx: EntityManager,
    pending: WagerTransactionOrmEntity,
    input: SubmitInput,
    money: Money,
    context: ConsumerContext | undefined,
  ): Promise<ProcessingResult> {
    const wallet = await this.lockWallet(tx, input, money);
    // Read again after wallet serialization, under a row lock, to avoid a second
    // worker processing a stale PENDING_REFERENCE entity from its Identity Map.
    const locked = await tx.findOneOrFail(
      WagerTransactionOrmEntity,
      { id: pending.id },
      {
        lockMode: LockMode.PESSIMISTIC_WRITE,
        refresh: true,
      },
    );
    if (locked.status !== WagerStatus.PENDING_REFERENCE) {
      return this.finishInbox(tx, context, {
        ...this.readSnapshot(locked.responseSnapshot),
        idempotentReplay: true,
      });
    }
    return this.resolvePendingAfterWallet(tx, locked, input, money, wallet, context);
  }

  private async resolvePendingAfterWallet(
    tx: EntityManager,
    pending: WagerTransactionOrmEntity,
    input: SubmitInput,
    money: Money,
    wallet: WalletOrmEntity,
    context: ConsumerContext | undefined,
  ): Promise<ProcessingResult> {
    const now = new Date();
    const reference = await tx.findOne(WagerTransactionOrmEntity, {
      providerId: input.providerId,
      externalTransactionId: input.referenceExternalTransactionId,
    });
    if (
      (!reference && pending.referenceExpiresAt && pending.referenceExpiresAt <= now) ||
      (!reference && pending.referenceAttempts >= PENDING_REFERENCE_MAX_ATTEMPTS)
    ) {
      pending.status = WagerStatus.REJECTED;
      pending.failureCode = 'REFERENCE_RETRY_EXHAUSTED';
      pending.processedAt = now;
      const response: ProcessingResult = {
        transactionId: pending.id,
        status: WagerStatus.REJECTED,
        balance: { amount: wallet.balance, currency: wallet.currency },
        idempotentReplay: false,
        failureCode: 'REFERENCE_RETRY_EXHAUSTED',
      };
      pending.responseSnapshot = response as unknown as Record<string, unknown>;
      this.enqueueWagerEvent(tx, pending.id, 'WagerTransactionRejected', input, response);
      return this.finishInbox(tx, context, response);
    }
    if (!reference) {
      pending.referenceAttempts += 1;
      pending.referenceNextAttemptAt = new Date(
        now.getTime() + 2 ** pending.referenceAttempts * 1_000,
      );
      const response = this.readSnapshot(pending.responseSnapshot);
      return this.finishInbox(tx, context, { ...response, idempotentReplay: false });
    }
    const result = this.persistResolvedOperation(
      tx,
      input,
      money,
      pending.idempotencyKey,
      pending.payloadHash,
      wallet,
      reference,
      context,
      pending,
    );
    return result;
  }

  private persistRejectedOperation(
    tx: EntityManager,
    input: SubmitInput,
    money: Money,
    idempotencyKey: string,
    payloadHash: string,
    wallet: WalletOrmEntity,
    failureCode: string,
    context: ConsumerContext | undefined,
    existingTransaction?: WagerTransactionOrmEntity,
  ): Promise<ProcessingResult> {
    return this.persistOperation(
      tx,
      input,
      money,
      idempotencyKey,
      payloadHash,
      wallet,
      undefined,
      Money.from({ amount: wallet.balance, currency: wallet.currency }),
      Money.from({ amount: wallet.balance, currency: wallet.currency }),
      undefined,
      WagerStatus.REJECTED,
      failureCode,
      context,
      existingTransaction,
    );
  }

  private async persistOperation(
    tx: EntityManager,
    input: SubmitInput,
    money: Money,
    idempotencyKey: string,
    payloadHash: string,
    wallet: WalletOrmEntity,
    referenceTransactionId: string | undefined,
    before: Money,
    after: Money,
    direction: LedgerDirection | undefined,
    status: WagerStatus,
    failureCode: string | undefined,
    context: ConsumerContext | undefined,
    existingTransaction?: WagerTransactionOrmEntity,
  ): Promise<ProcessingResult> {
    const transactionId = existingTransaction?.id ?? randomUUID();
    const domainTransaction = existingTransaction
      ? WagerTransaction.rehydrate({
          id: transactionId,
          providerId: input.providerId,
          externalTransactionId: input.externalTransactionId,
          idempotencyKey,
          payloadHash,
          walletId: wallet.id,
          playerId: input.playerId,
          roundId: input.roundId,
          gameId: input.gameId,
          kind: input.kind,
          money,
          referenceExternalTransactionId: input.referenceExternalTransactionId,
          createdAt: existingTransaction.createdAt ?? new Date(),
          status: existingTransaction.status as WagerStatus,
          referenceTransactionId: existingTransaction.referenceTransactionId,
          failureCode: existingTransaction.failureCode as FailureCode | undefined,
          processedAt: existingTransaction.processedAt,
        })
      : WagerTransaction.create({
          id: transactionId,
          providerId: input.providerId,
          externalTransactionId: input.externalTransactionId,
          idempotencyKey,
          payloadHash,
          walletId: wallet.id,
          playerId: input.playerId,
          roundId: input.roundId,
          gameId: input.gameId,
          kind: input.kind,
          money,
          referenceExternalTransactionId: input.referenceExternalTransactionId,
        });
    if (status === WagerStatus.PROCESSED) domainTransaction.markProcessed(referenceTransactionId);
    else if (status === WagerStatus.REJECTED) domainTransaction.reject(failureCode as FailureCode);
    const transaction =
      existingTransaction ??
      tx.create(WagerTransactionOrmEntity, {
        id: transactionId,
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        idempotencyKey,
        payloadHash,
        walletId: wallet.id,
        playerId: input.playerId,
        roundId: input.roundId,
        gameId: input.gameId,
        kind: input.kind,
        amount: money.toString(),
        currency: money.currency,
        status,
        referenceExternalTransactionId: input.referenceExternalTransactionId,
        referenceTransactionId,
        failureCode,
        responseSnapshot: undefined,
        processedAt: new Date(),
        referenceAttempts: 0,
      });
    transaction.status = domainTransaction.status;
    transaction.referenceTransactionId = domainTransaction.referenceTransactionId;
    transaction.failureCode = domainTransaction.failureCode;
    transaction.processedAt = domainTransaction.processedAt;
    if (existingTransaction) existingTransaction.referenceNextAttemptAt = undefined;
    const response: ProcessingResult = {
      transactionId,
      status,
      balance: after.toJSON(),
      idempotentReplay: false,
      ...(failureCode ? { failureCode } : {}),
    };
    transaction.responseSnapshot = response as unknown as Record<string, unknown>;
    tx.persist(transaction);
    await tx.flush();
    if (status === WagerStatus.PROCESSED && direction) {
      const domainWallet = Wallet.rehydrate({
        id: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        balance: before,
        version: wallet.version,
        createdAt: wallet.createdAt ?? new Date(),
        updatedAt: wallet.updatedAt ?? new Date(),
      });
      if (direction === LedgerDirection.DEBIT) domainWallet.debit(money);
      else domainWallet.credit(money);
      if (!domainWallet.balance.equals(after)) throw new Error('WALLET_LEDGER_DIVERGENCE');
      const ledgerId = randomUUID();
      WalletLedgerEntry.create({
        id: ledgerId,
        walletId: wallet.id,
        transactionId,
        direction,
        money,
        balanceBefore: before,
        balanceAfter: domainWallet.balance,
      });
      wallet.balance = domainWallet.balance.toString();
      wallet.version = domainWallet.version;
      tx.persist(
        tx.create(LedgerOrmEntity, {
          id: ledgerId,
          walletId: wallet.id,
          transactionId,
          direction,
          amount: money.toString(),
          currency: money.currency,
          balanceBefore: before.toString(),
          balanceAfter: after.toString(),
        }),
      );
    }
    const eventType =
      status === WagerStatus.PROCESSED ? 'WagerTransactionProcessed' : 'WagerTransactionRejected';
    this.enqueueWagerEvent(tx, transactionId, eventType as WagerEventType, input, response);
    if (status === WagerStatus.PROCESSED && direction) {
      this.enqueueBalanceChangedEvent(tx, transactionId, input, wallet, before, after, direction);
    }
    return this.finishInbox(tx, context, response);
  }

  private enqueueWagerEvent(
    tx: EntityManager,
    transactionId: string,
    eventType: WagerEventType,
    input: SubmitInput,
    response: ProcessingResult,
  ): void {
    const event = createWagerEvent(eventType, transactionId, input.externalTransactionId, {
      transactionId,
      status: response.status,
      failureCode: response.failureCode,
      money: input.money,
    });
    this.persistOutboxEvent(tx, event);
  }

  private enqueueBalanceChangedEvent(
    tx: EntityManager,
    transactionId: string,
    input: SubmitInput,
    wallet: WalletOrmEntity,
    before: Money,
    after: Money,
    direction: LedgerDirection,
  ): void {
    const event = createWalletBalanceChangedEvent(transactionId, input.externalTransactionId, {
      walletId: wallet.id,
      transactionId,
      direction,
      money: input.money,
      balanceBefore: before.toJSON(),
      balanceAfter: after.toJSON(),
      walletVersion: wallet.version,
    });
    this.persistOutboxEvent(tx, event);
  }

  private persistOutboxEvent(tx: EntityManager, event: IntegrationEvent<unknown>): void {
    const payload = event.toJSON();
    tx.persist(
      tx.create(OutboxOrmEntity, {
        id: randomUUID(),
        aggregateId: payload.aggregateId,
        eventType: payload.eventType,
        attempts: 0,
        payload,
      }),
    );
  }

  private finishInbox(
    tx: EntityManager,
    context: ConsumerContext | undefined,
    result: ProcessingResult,
  ): ProcessingResult {
    if (context) {
      const inbox = tx
        .getUnitOfWork()
        .getById(InboxOrmEntity.name, [context.messageId, context.consumerName]) as
        InboxOrmEntity | undefined;
      if (inbox) inbox.processedAt = new Date();
    }
    return result;
  }

  private validateInput(idempotencyKey: string, input: SubmitInput): void {
    if (!idempotencyKey?.trim())
      throw new FinancialProcessingError('IDEMPOTENCY_KEY_REQUIRED', 400);
    if (
      ![
        WagerKind.BET,
        WagerKind.WIN,
        WagerKind.LOSS,
        WagerKind.REFUND,
        WagerKind.ROLLBACK,
      ].includes(input.kind)
    ) {
      throw new FinancialProcessingError('INVALID_OPERATION', 422);
    }
    if (
      (input.kind === WagerKind.REFUND || input.kind === WagerKind.ROLLBACK) &&
      !input.referenceExternalTransactionId
    ) {
      throw new FinancialProcessingError('REFERENCE_REQUIRED', 400);
    }
  }

  private async findConcurrentIdempotencyResult(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransactionOrmEntity | null> {
    // A private fork avoids clearing the caller's request-scoped identity map.
    const lookupEm = this.em.fork({ clear: true, useContext: false });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const transaction = await lookupEm.findOne(
        WagerTransactionOrmEntity,
        {
          providerId,
          idempotencyKey,
        },
        { refresh: true },
      );
      if (transaction) return transaction;
      await this.sleep(20 * (attempt + 1));
    }
    return null;
  }

  private readSnapshot(snapshot: Record<string, unknown> | undefined): ProcessingResult {
    if (
      !snapshot ||
      typeof snapshot.transactionId !== 'string' ||
      typeof snapshot.status !== 'string'
    ) {
      throw new FinancialProcessingError('SNAPSHOT_UNAVAILABLE', 503);
    }
    return snapshot as unknown as ProcessingResult;
  }

  private isUniqueViolation(error: unknown): boolean {
    let current: unknown = error;
    for (let depth = 0; depth < 4; depth++) {
      if (typeof current !== 'object' || current === null) break;
      const candidate = current as {
        code?: unknown;
        sqlState?: unknown;
        driverException?: unknown;
        cause?: unknown;
      };
      if (candidate.code === '23505' || candidate.sqlState === '23505') return true;
      current = candidate.driverException ?? candidate.cause;
    }
    return false;
  }

  private isRetryableTransaction(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const candidate = error as { code?: unknown; sqlState?: unknown };
    return (
      ['40P01', '40001'].includes(String(candidate.code)) ||
      ['40P01', '40001'].includes(String(candidate.sqlState))
    );
  }

  private sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}

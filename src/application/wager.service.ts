import {
  Injectable,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import {
  WalletEntity,
  WagerTransactionEntity,
  LedgerEntity,
  OutboxEntity,
} from '../infrastructure/database/entities';
import { Money } from '../domain/money';
import { WagerKind, WagerStatus, FailureCode } from '../domain/wager-transaction';
import { LedgerDirection } from '../domain/ledger';
import { canonicalHash } from './canonical-hash';
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
@Injectable()
export class WagerService {
  constructor(private readonly db: DataSource) {}
  async createWallet(playerId: string, money: { amount: string; currency: string }) {
    const m = Money.from(money);
    const id = randomUUID();
    return this.db.transaction(async (tx) => {
      const repo = tx.getRepository(WalletEntity);
      const wallet = repo.create({
        id,
        playerId,
        currency: m.currency,
        balance: m.toString(),
        version: 1,
      });
      try {
        await repo.insert(wallet);
      } catch {
        throw new ConflictException('wallet already exists');
      }
      if (m.isPositive()) {
        const wager = tx.getRepository(WagerTransactionEntity).create({
          id: randomUUID(),
          providerId: '__internal__',
          externalTransactionId: `opening:${id}`,
          idempotencyKey: `opening:${id}`,
          payloadHash: 'internal',
          walletId: id,
          playerId,
          roundId: '__internal__',
          gameId: '__internal__',
          kind: 'OPENING',
          amount: m.toString(),
          currency: m.currency,
          status: 'PROCESSED',
          processedAt: new Date(),
        });
        await tx.getRepository(WagerTransactionEntity).insert(wager);
        await tx.getRepository(LedgerEntity).insert({
          id: randomUUID(),
          walletId: id,
          transactionId: wager.id,
          direction: 'CREDIT',
          amount: m.toString(),
          currency: m.currency,
          balanceBefore: '0.00',
          balanceAfter: m.toString(),
        });
      }
      return { id, playerId, balance: m.toJSON(), version: 1 };
    });
  }
  async submit(key: string, input: SubmitInput) {
    const money = Money.from(input.money);
    const hash = canonicalHash({ ...input, money: money.toJSON() });
    return this.db.transaction(async (tx) => {
      const tr = tx.getRepository(WagerTransactionEntity);
      const existing = await tr.findOne({
        where: { idempotencyKey: key, providerId: input.providerId },
      });
      if (existing) {
        if (existing.payloadHash !== hash)
          throw new ConflictException('idempotency key payload conflict');
        return {
          ...(typeof existing.responseSnapshot === 'string'
            ? (JSON.parse(existing.responseSnapshot) as object)
            : {}),
          idempotentReplay: true,
        };
      }
      const wallet = await tx
        .getRepository(WalletEntity)
        .createQueryBuilder('w')
        .setLock('pessimistic_write')
        .where('w.id=:id', { id: input.walletId })
        .getOne();
      if (!wallet) throw new NotFoundException(FailureCode.WALLET_NOT_FOUND);
      if (wallet.playerId !== input.playerId || wallet.currency !== money.currency)
        throw new UnprocessableEntityException(FailureCode.WALLET_CONTEXT_MISMATCH);
      const entity = tr.create({
        id: randomUUID(),
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        idempotencyKey: key,
        payloadHash: hash,
        walletId: wallet.id,
        playerId: input.playerId,
        roundId: input.roundId,
        gameId: input.gameId,
        kind: input.kind,
        amount: money.toString(),
        currency: money.currency,
        status: WagerStatus.PENDING,
        referenceExternalTransactionId: input.referenceExternalTransactionId ?? null,
      });
      let direction: LedgerDirection | undefined;
      const before = Money.from({ amount: wallet.balance, currency: wallet.currency });
      let after = before;
      let status = WagerStatus.PROCESSED;
      let failure: string | undefined;
      try {
        if (input.kind === WagerKind.BET) {
          if (before.isLessThan(money)) throw new Error(FailureCode.INSUFFICIENT_FUNDS);
          after = before.subtract(money);
          direction = LedgerDirection.DEBIT;
        } else if (input.kind === WagerKind.WIN) {
          after = before.add(money);
          direction = LedgerDirection.CREDIT;
        } else if (input.kind === WagerKind.REFUND || input.kind === WagerKind.ROLLBACK) {
          const ref = input.referenceExternalTransactionId
            ? await tr.findOne({
                where: {
                  providerId: input.providerId,
                  externalTransactionId: input.referenceExternalTransactionId,
                },
              })
            : null;
          if (!ref) throw new Error(FailureCode.REFERENCE_NOT_FOUND);
          if (ref.status !== WagerStatus.PROCESSED)
            throw new Error(FailureCode.REFERENCE_NOT_PROCESSED);
          if (
            ref.playerId !== input.playerId ||
            ref.walletId !== input.walletId ||
            ref.roundId !== input.roundId ||
            ref.currency !== money.currency
          )
            throw new Error(FailureCode.REFERENCE_CONTEXT_MISMATCH);
          if (ref.amount !== money.toString()) throw new Error(FailureCode.AMOUNT_MISMATCH);
          if (input.kind === WagerKind.REFUND && ref.kind !== 'BET')
            throw new Error(FailureCode.INVALID_REFERENCE_KIND);
          if (input.kind === WagerKind.ROLLBACK && !['BET', 'WIN', 'REFUND'].includes(ref.kind))
            throw new Error(FailureCode.INVALID_REFERENCE_KIND);
          if (input.kind === WagerKind.REFUND || ref.kind === 'BET') {
            after = before.add(money);
            direction = LedgerDirection.CREDIT;
          } else {
            if (before.isLessThan(money)) throw new Error(FailureCode.REVERSAL_INSUFFICIENT_FUNDS);
            after = before.subtract(money);
            direction = LedgerDirection.DEBIT;
          }
        }
      } catch (e) {
        status = WagerStatus.REJECTED;
        failure = e instanceof Error ? e.message : FailureCode.INVALID_OPERATION;
      }
      entity.status = status;
      entity.failureCode = failure ?? null;
      entity.processedAt = new Date();
      const response = {
        transactionId: entity.id,
        status,
        balance: { amount: after.toString(), currency: money.currency },
        idempotentReplay: false,
      };
      entity.responseSnapshot = JSON.stringify(response);
      await tr.insert(entity);
      if (status === WagerStatus.PROCESSED && direction) {
        wallet.balance = after.toString();
        wallet.version += 1;
        await tx.getRepository(WalletEntity).save(wallet);
        await tx.getRepository(LedgerEntity).insert({
          id: randomUUID(),
          walletId: wallet.id,
          transactionId: entity.id,
          direction,
          amount: money.toString(),
          currency: money.currency,
          balanceBefore: before.toString(),
          balanceAfter: after.toString(),
        });
      }
      const eventType =
        status === WagerStatus.PROCESSED ? 'WagerTransactionProcessed' : 'WagerTransactionRejected';
      await tx.getRepository(OutboxEntity).insert({
        id: randomUUID(),
        aggregateId: entity.id,
        eventType,
        payload: {
          eventId: randomUUID(),
          eventType,
          version: 1,
          aggregateId: entity.id,
          correlationId: key,
          occurredAt: new Date().toISOString(),
          data: {
            transactionId: entity.id,
            status,
            balance: { amount: after.toString(), currency: money.currency },
          },
        },
      });
      return response;
    });
  }
  async getWallet(id: string) {
    const w = await this.db.getRepository(WalletEntity).findOne({ where: { id } });
    if (!w) throw new NotFoundException();
    return {
      id: w.id,
      playerId: w.playerId,
      balance: { amount: w.balance, currency: w.currency },
      version: w.version,
    };
  }
}

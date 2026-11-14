import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { Money } from '../../domain/money';
import {
  InboxOrmEntity,
  LedgerOrmEntity,
  OutboxOrmEntity,
  WagerTransactionOrmEntity,
  WalletOrmEntity,
} from '../../infrastructure/database/mikro-orm/entities';

export interface CreateWalletResult {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

export interface LedgerCursor {
  createdAt: string;
  id: string;
}

export interface LedgerPage {
  items: Array<{
    id: string;
    walletId: string;
    transactionId: string;
    direction: string;
    amount: { amount: string; currency: string };
    balanceBefore: { amount: string; currency: string };
    balanceAfter: { amount: string; currency: string };
    createdAt: string;
  }>;
  nextCursor?: string;
}

export interface WalletReconciliation {
  walletId: string;
  storedBalance: { amount: string; currency: string };
  calculatedBalance: { amount: string; currency: string };
  difference: { amount: string; currency: string };
  consistent: boolean;
  checkedEntries: number;
}

export function encodeLedgerCursor(cursor: LedgerCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeLedgerCursor(value: string): LedgerCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Partial<LedgerCursor>;
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') throw new Error();
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new BadRequestException('INVALID_LEDGER_CURSOR');
  }
}

@Injectable()
export class WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async create(playerId: string, initialBalance: Money): Promise<CreateWalletResult> {
    const walletId = randomUUID();
    try {
      return await this.em.transactional(async (tx) => {
        const wallet = tx.create(WalletOrmEntity, {
          id: walletId,
          playerId,
          currency: initialBalance.currency,
          balance: initialBalance.toString(),
          version: 1,
        });
        await tx.persistAndFlush(wallet);

        if (initialBalance.isPositive()) {
          const transactionId = randomUUID();
          const opening = tx.create(WagerTransactionOrmEntity, {
            id: transactionId,
            providerId: '__internal__',
            externalTransactionId: `opening:${walletId}`,
            idempotencyKey: `opening:${walletId}`,
            payloadHash: '0'.repeat(64),
            walletId,
            playerId,
            roundId: '__internal__',
            gameId: '__internal__',
            kind: 'OPENING',
            amount: initialBalance.toString(),
            currency: initialBalance.currency,
            status: 'PROCESSED',
            processedAt: new Date(),
            referenceAttempts: 0,
          });
          tx.persist(opening);
          await tx.flush();
          tx.persist(
            tx.create(LedgerOrmEntity, {
              id: randomUUID(),
              walletId,
              transactionId,
              direction: 'CREDIT',
              amount: initialBalance.toString(),
              currency: initialBalance.currency,
              balanceBefore: '0.00',
              balanceAfter: initialBalance.toString(),
            }),
          );
        }

        await tx.flush();
        return {
          id: wallet.id,
          playerId: wallet.playerId,
          balance: { amount: wallet.balance, currency: wallet.currency },
          version: wallet.version,
        };
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) throw new ConflictException('WALLET_ALREADY_EXISTS');
      throw error;
    }
  }

  async findById(id: string): Promise<CreateWalletResult> {
    const wallet = await this.em.findOne(WalletOrmEntity, { id });
    if (!wallet) throw new NotFoundException('WALLET_NOT_FOUND');
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: { amount: wallet.balance, currency: wallet.currency },
      version: wallet.version,
    };
  }

  async findLedger(walletId: string, limit: number, cursor?: string): Promise<LedgerPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('INVALID_LEDGER_LIMIT');
    }
    await this.findById(walletId);
    const params: unknown[] = [walletId];
    let cursorClause = '';
    if (cursor) {
      const decoded = decodeLedgerCursor(cursor);
      params.push(decoded.createdAt, decoded.id);
      cursorClause = ' and (created_at, id) < ($2::timestamptz, $3::uuid)';
    }
    params.push(limit + 1);
    const limitPosition = params.length;
    const rows = await this.em.getConnection().execute<LedgerRow[]>(
      `select id, wallet_id, transaction_id, direction, amount::text, currency,
              balance_before::text, balance_after::text, created_at
         from wallet_ledger_entries
        where wallet_id = $1${cursorClause}
        order by created_at desc, id desc
        limit $${limitPosition}`,
      params,
    );
    const hasNext = rows.length > limit;
    const pageRows = hasNext ? rows.slice(0, limit) : rows;
    return {
      items: pageRows.map((row) => ({
        id: row.id,
        walletId: row.wallet_id,
        transactionId: row.transaction_id,
        direction: row.direction,
        amount: { amount: row.amount, currency: row.currency },
        balanceBefore: { amount: row.balance_before, currency: row.currency },
        balanceAfter: { amount: row.balance_after, currency: row.currency },
        createdAt: new Date(row.created_at).toISOString(),
      })),
      nextCursor: hasNext
        ? encodeLedgerCursor({
            createdAt: new Date(pageRows[pageRows.length - 1].created_at).toISOString(),
            id: pageRows[pageRows.length - 1].id,
          })
        : undefined,
    };
  }

  async reconcile(walletId: string): Promise<WalletReconciliation> {
    const rows = await this.em.getConnection().execute<ReconciliationRow[]>(
      `select wallet.id as wallet_id,
              wallet.currency,
              wallet.balance::text as stored_balance,
              coalesce(
                sum(case ledger.direction
                      when 'CREDIT' then ledger.amount
                      when 'DEBIT' then -ledger.amount
                      else 0
                    end),
                0
              )::numeric(20,2)::text as calculated_balance,
              count(ledger.id)::text as checked_entries
         from wallets as wallet
         left join wallet_ledger_entries as ledger on ledger.wallet_id = wallet.id
        where wallet.id = ?::uuid
        group by wallet.id, wallet.currency, wallet.balance`,
      [walletId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundException('WALLET_NOT_FOUND');
    const stored = Money.from({ amount: row.stored_balance, currency: row.currency });
    const calculated = Money.from({ amount: row.calculated_balance, currency: row.currency });
    const difference = stored.subtract(calculated);
    return {
      walletId: row.wallet_id,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent: difference.isZero(),
      checkedEntries: Number.parseInt(row.checked_entries, 10),
    };
  }

  private isUniqueViolation(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
  }
}

interface LedgerRow {
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: string | Date;
}

interface ReconciliationRow {
  wallet_id: string;
  currency: string;
  stored_balance: string;
  calculated_balance: string;
  checked_entries: string;
}

export const persistenceEntities = [
  WalletOrmEntity,
  WagerTransactionOrmEntity,
  LedgerOrmEntity,
  InboxOrmEntity,
  OutboxOrmEntity,
];

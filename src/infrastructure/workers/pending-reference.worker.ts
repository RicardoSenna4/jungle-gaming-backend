import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectEntityManager } from '@mikro-orm/nestjs';
import { EntityManager } from '@mikro-orm/postgresql';
import { WagerStatus } from '../../domain/wager-transaction';
import { WagerProcessingService } from '../../application/wager-processing.service';
import { WagerTransactionOrmEntity } from '../database/mikro-orm/entities';

export interface PendingReferenceRunResult {
  inspected: number;
  reprocessed: number;
  expired: number;
  failed: number;
}

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly intervalMs = Number(process.env.PENDING_REFERENCE_INTERVAL_MS ?? 1_000);

  constructor(
    private readonly service: WagerProcessingService,
    @InjectEntityManager('default') private readonly em: EntityManager,
  ) {}

  onModuleInit(): void {
    if (process.env.ENABLE_PENDING_REFERENCE_WORKER !== 'false') this.start();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async runOnce(now = new Date()): Promise<PendingReferenceRunResult> {
    if (this.running) return { inspected: 0, reprocessed: 0, expired: 0, failed: 0 };
    this.running = true;
    try {
      const pending = await this.em.find(
        WagerTransactionOrmEntity,
        {
          status: WagerStatus.PENDING_REFERENCE,
          $or: [{ referenceNextAttemptAt: null }, { referenceNextAttemptAt: { $lte: now } }],
        },
        { limit: 100, orderBy: { createdAt: 'ASC' } },
      );
      let reprocessed = 0;
      let expired = 0;
      let failed = 0;
      for (const item of pending) {
        try {
          const result = await this.service.reprocessPendingReference(item.id, now);
          if (result?.status === WagerStatus.REJECTED) expired += 1;
          else if (result) reprocessed += 1;
        } catch {
          failed += 1;
        }
      }
      return { inspected: pending.length, reprocessed, expired, failed };
    } finally {
      this.running = false;
    }
  }
}

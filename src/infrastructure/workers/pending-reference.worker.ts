import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EnsureRequestContext } from '@mikro-orm/core';
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
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private timer?: ReturnType<typeof setInterval>;
  private inFlight?: Promise<PendingReferenceRunResult>;
  private running = false;
  private readonly intervalMs = Number(process.env.PENDING_REFERENCE_INTERVAL_MS ?? 1_000);

  constructor(
    private readonly service: WagerProcessingService,
    private readonly em: EntityManager,
  ) {}

  onModuleInit(): void {
    if (process.env.ENABLE_PENDING_REFERENCE_WORKER !== 'false') this.start();
  }

  async onModuleDestroy(): Promise<void> {
    this.stop();
    await this.inFlight;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.inFlight) return;
      const task = this.runOnce();
      this.inFlight = task;
      void task
        .catch((error: unknown) => {
          this.logger.error(
            JSON.stringify({
              event: 'pending_reference_tick_failed',
              errorName: error instanceof Error ? error.name : 'UnknownError',
            }),
          );
        })
        .finally(() => {
          if (this.inFlight === task) this.inFlight = undefined;
        });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  @EnsureRequestContext((self: PendingReferenceWorker) => self.em)
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

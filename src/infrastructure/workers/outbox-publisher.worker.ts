import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { EnsureRequestContext } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';
import { MetricsService } from '../telemetry/metrics.service';
import { SqsInfrastructureClient } from './sqs-infrastructure.client';

interface ClaimedOutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown> | string;
  attempts: number | string;
  claim_token: string;
}

export interface OutboxRunResult {
  claimed: number;
  published: number;
  failed: number;
}

@Injectable()
export class OutboxPublisherWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private readonly batchSize = this.readPositiveInteger(process.env.OUTBOX_BATCH_SIZE, 20);
  private readonly intervalMs = this.readPositiveInteger(process.env.OUTBOX_INTERVAL_MS, 500);
  private readonly leaseSeconds = this.readPositiveInteger(process.env.OUTBOX_LEASE_SECONDS, 60);
  private stopping = false;
  private loop?: Promise<void>;
  private running = false;

  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SqsInfrastructureClient,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    if (process.env.ENABLE_OUTBOX_PUBLISHER === 'true') this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.loop) return;
    this.stopping = false;
    this.loop = this.pollLoop();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.loop;
    this.loop = undefined;
  }

  @EnsureRequestContext((self: OutboxPublisherWorker) => self.em)
  async runOnce(): Promise<OutboxRunResult> {
    if (this.running) return { claimed: 0, published: 0, failed: 0 };
    this.running = true;
    try {
      const rows = await this.claimBatch();
      let published = 0;
      let failed = 0;
      for (const row of rows) {
        try {
          await this.sqs.publishEvent(this.parsePayload(row.payload), row.aggregate_id);
          await this.markPublished(row.id, row.claim_token);
          published += 1;
          this.metrics.increment('outbox_publish_total', { result: 'published' });
        } catch (error) {
          failed += 1;
          await this.scheduleRetry(row.id, row.claim_token, Number(row.attempts));
          this.metrics.increment('outbox_publish_total', { result: 'retry' });
          this.logger.warn(
            JSON.stringify({
              event: 'outbox_publish_failed',
              outboxId: row.id,
              eventType: row.event_type,
              errorName: error instanceof Error ? error.name : 'UnknownError',
            }),
          );
        }
      }
      await this.updateLagGauge();
      return { claimed: rows.length, published, failed };
    } finally {
      this.running = false;
    }
  }

  private async claimBatch(): Promise<ClaimedOutboxRow[]> {
    const claimToken = randomUUID();
    return this.em.transactional((tx) =>
      tx.getConnection().execute<ClaimedOutboxRow[]>(
        `with due as (
           select id
             from outbox_messages
            where published_at is null
              and (next_attempt_at is null or next_attempt_at <= now())
              and (claimed_until is null or claimed_until <= now())
            order by occurred_at asc, id asc
            for update skip locked
            limit ?
         )
         update outbox_messages as outbox
            set claim_token = ?::uuid,
                claimed_until = now() + (?::int * interval '1 second'),
                attempts = attempts + 1
           from due
          where outbox.id = due.id
         returning outbox.id, outbox.aggregate_id, outbox.event_type,
                   outbox.payload, outbox.attempts, outbox.claim_token`,
        [this.batchSize, claimToken, this.leaseSeconds],
      ),
    );
  }

  private async markPublished(id: string, claimToken: string): Promise<void> {
    await this.em.getConnection().execute(
      `update outbox_messages
          set published_at = now(), next_attempt_at = null,
              claimed_until = null, claim_token = null
        where id = ? and claim_token = ?::uuid and published_at is null`,
      [id, claimToken],
    );
  }

  private async scheduleRetry(id: string, claimToken: string, attempts: number): Promise<void> {
    const retrySeconds = Math.min(2 ** Math.max(attempts - 1, 0), 300);
    await this.em.getConnection().execute(
      `update outbox_messages
          set next_attempt_at = now() + (?::int * interval '1 second'),
              claimed_until = null, claim_token = null
        where id = ? and claim_token = ?::uuid and published_at is null`,
      [retrySeconds, id, claimToken],
    );
  }

  private async updateLagGauge(): Promise<void> {
    const rows = await this.em
      .getConnection()
      .execute<
        Array<{ pending_count: string | number; oldest_age_seconds: string | number | null }>
      >(
        `select count(*) as pending_count,
              coalesce(extract(epoch from now() - min(occurred_at)), 0) as oldest_age_seconds
         from outbox_messages
        where published_at is null`,
      );
    this.metrics.setGauge('outbox_pending_messages', Number(rows[0]?.pending_count ?? 0));
    this.metrics.setGauge(
      'outbox_oldest_pending_age_seconds',
      Number(rows[0]?.oldest_age_seconds ?? 0),
    );
  }

  private parsePayload(payload: ClaimedOutboxRow['payload']): Record<string, unknown> {
    const value = typeof payload === 'string' ? JSON.parse(payload) : payload;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('INVALID_OUTBOX_PAYLOAD');
    }
    return value as Record<string, unknown>;
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.runOnce();
      } catch (error) {
        this.logger.error(
          JSON.stringify({
            event: 'outbox_poll_failed',
            errorName: error instanceof Error ? error.name : 'UnknownError',
          }),
        );
      }
      if (!this.stopping) await new Promise((resolve) => setTimeout(resolve, this.intervalMs));
    }
  }

  private readPositiveInteger(value: string | undefined, fallback: number): number {
    if (value === undefined) return fallback;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 1)
      throw new Error('INVALID_OUTBOX_WORKER_CONFIGURATION');
    return parsed;
  }
}

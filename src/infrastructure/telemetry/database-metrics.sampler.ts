import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { MetricsService } from './metrics.service';
@Injectable()
export class DatabaseMetricsSampler implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  constructor(
    private readonly em: EntityManager,
    private readonly metrics: MetricsService,
  ) {}
  onModuleInit() {
    if (process.env.ENABLE_DB_METRICS_SAMPLER === 'true') {
      this.tick();
      this.timer = setInterval(() => this.tick(), 10000);
      this.timer.unref();
    }
  }
  private tick() {
    if (!this.active)
      this.active = this.collect().finally(() => {
        this.active = undefined;
      });
  }
  async collect() {
    try {
      const em = this.em.fork();
      const rows = await em.execute<Array<{ status: string; count: string }>>(
        'select status,count(*)::text as count from message_quarantine group by status',
      );
      for (const status of ['OPEN', 'REDRIVING', 'RELEASED', 'RESOLVED'])
        this.metrics.setGauge(
          'quarantine_messages',
          Number(rows.find((row) => row.status === status)?.count ?? 0),
          { status },
        );
      const pending = await em.execute(
        'select count(*)::integer as count,coalesce(extract(epoch from clock_timestamp()-min(occurred_at)),0)::float as age from outbox_messages where published_at is null',
      );
      this.metrics.setGauge('outbox_pending_messages', pending[0].count);
      this.metrics.setGauge('outbox_oldest_pending_age_seconds', pending[0].age);
      this.metrics.setGauge('database_metrics_collection_success', 1);
    } catch {
      this.metrics.setGauge('database_metrics_collection_success', 0);
    }
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
}

import { EntityManager } from '@mikro-orm/postgresql';
import { MetricsService } from '../../src/infrastructure/telemetry/metrics.service';
import { OutboxPublisherWorker } from '../../src/infrastructure/workers/outbox-publisher.worker';
import { SqsInfrastructureClient } from '../../src/infrastructure/workers/sqs-infrastructure.client';

function createHarness(publish: () => Promise<void>) {
  const sqlCalls: Array<{ sql: string; params: unknown[] }> = [];
  const claimed = [
    {
      id: 'outbox-1',
      aggregate_id: 'aggregate-1',
      event_type: 'WagerTransactionProcessed',
      payload: { eventId: 'event-1', eventType: 'WagerTransactionProcessed' },
      attempts: 1,
      claim_token: '4e46ae5e-dc45-48f0-a66a-33aa6c169b28',
    },
  ];
  const connection = {
    execute: async (sql: string, params: unknown[] = []) => {
      sqlCalls.push({ sql, params });
      if (sql.includes('with due as')) return claimed;
      if (sql.includes('select count(*) as pending_count')) {
        return [{ pending_count: '0', oldest_age_seconds: '0' }];
      }
      return [];
    },
  };
  const em = {
    transactional: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ getConnection: () => connection }),
    getConnection: () => connection,
  } as unknown as EntityManager;
  const sqs = { publishEvent: publish } as unknown as SqsInfrastructureClient;
  const metrics = new MetricsService();
  const worker = new OutboxPublisherWorker(em, sqs, metrics);
  return { worker, metrics, sqlCalls };
}

describe('OutboxPublisherWorker', () => {
  it('publishes claimed events and acknowledges only with the matching lease token', async () => {
    const published: unknown[] = [];
    const { worker, metrics, sqlCalls } = createHarness(async (...args: unknown[]) => {
      published.push(args);
    });

    await expect(worker.runOnce()).resolves.toEqual({ claimed: 1, published: 1, failed: 0 });
    expect(published).toHaveLength(1);
    const mark = sqlCalls.find((call) => call.sql.includes('set published_at = now()'));
    expect(mark?.sql).toContain('claim_token = ?::uuid');
    expect(mark?.params).toEqual(['outbox-1', '4e46ae5e-dc45-48f0-a66a-33aa6c169b28']);
    expect(metrics.renderPrometheus()).toContain('outbox_publish_total{result="published"} 1');
  });

  it('schedules a bounded retry and releases the lease when SQS publication fails', async () => {
    const { worker, metrics, sqlCalls } = createHarness(async () => {
      throw new Error('queue unavailable');
    });

    await expect(worker.runOnce()).resolves.toEqual({ claimed: 1, published: 0, failed: 1 });
    const retry = sqlCalls.find((call) => call.sql.includes('set next_attempt_at = now()'));
    expect(retry?.sql).toContain('claim_token = ?::uuid');
    expect(retry?.params).toEqual([1, 'outbox-1', '4e46ae5e-dc45-48f0-a66a-33aa6c169b28']);
    expect(metrics.renderPrometheus()).toContain('outbox_publish_total{result="retry"} 1');
  });
});

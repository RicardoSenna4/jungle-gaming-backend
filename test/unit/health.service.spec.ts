import { EntityManager } from '@mikro-orm/postgresql';
import { HealthService } from '../../src/infrastructure/telemetry/health.service';
import { SqsInfrastructureClient } from '../../src/infrastructure/workers/sqs-infrastructure.client';

describe('HealthService', () => {
  it('reports ready only when PostgreSQL and both SQS queues are reachable', async () => {
    const em = {
      getConnection: () => ({ execute: async () => [{ '?column?': 1 }] }),
    } as unknown as EntityManager;
    const sqs = {
      commandQueueUrl: 'http://localstack/commands',
      eventsQueueUrl: 'http://localstack/events',
      assertQueueReachable: async () => undefined,
    } as unknown as SqsInfrastructureClient;
    const health = new HealthService(em, sqs);

    await expect(health.readiness()).resolves.toEqual({
      status: 'ok',
      checks: { postgres: 'up', sqs: 'up' },
    });
  });

  it('reports a failed dependency without exposing its error details', async () => {
    const em = {
      getConnection: () => ({
        execute: async () => {
          throw new Error('secret host');
        },
      }),
    } as unknown as EntityManager;
    const sqs = {
      commandQueueUrl: 'http://localstack/commands',
      eventsQueueUrl: 'http://localstack/events',
      assertQueueReachable: async () => undefined,
    } as unknown as SqsInfrastructureClient;
    const health = new HealthService(em, sqs);

    await expect(health.readiness()).resolves.toEqual({
      status: 'error',
      checks: { postgres: 'down', sqs: 'up' },
    });
  });
});

import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { SqsInfrastructureClient } from '../workers/sqs-infrastructure.client';

export interface ReadinessResult {
  status: 'ok' | 'error';
  checks: {
    postgres: 'up' | 'down';
    sqs: 'up' | 'down';
  };
}

@Injectable()
export class HealthService {
  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SqsInfrastructureClient,
  ) {}

  async readiness(): Promise<ReadinessResult> {
    const [database, commandQueue, eventsQueue] = await Promise.allSettled([
      this.em.getConnection().execute('select 1'),
      this.sqs.assertQueueReachable(this.sqs.commandQueueUrl),
      this.sqs.assertQueueReachable(this.sqs.eventsQueueUrl),
    ]);
    const postgres = database.status === 'fulfilled' ? 'up' : 'down';
    const sqs =
      commandQueue.status === 'fulfilled' && eventsQueue.status === 'fulfilled' ? 'up' : 'down';
    return {
      status: postgres === 'up' && sqs === 'up' ? 'ok' : 'error',
      checks: { postgres, sqs },
    };
  }
}

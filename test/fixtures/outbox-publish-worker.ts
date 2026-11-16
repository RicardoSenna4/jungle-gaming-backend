import { Logger } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/infrastructure/database/mikro-orm.config';
import { OutboxPublisherWorker } from '../../src/infrastructure/workers/outbox-publisher.worker';
import { SqsInfrastructureClient } from '../../src/infrastructure/workers/sqs-infrastructure.client';
import { MetricsService } from '../../src/infrastructure/telemetry/metrics.service';
if (
  process.env.NODE_ENV !== 'test' ||
  !process.env.DB_NAME?.startsWith('jungle_outbox_test_') ||
  !['localhost', '127.0.0.1'].includes(process.env.DB_HOST ?? '') ||
  new URL(process.env.SQS_ENDPOINT!).hostname !== 'localhost' ||
  process.env.AWS_ACCESS_KEY_ID !== 'test'
)
  throw new Error('ISOLATED_TEST_ONLY');
Logger.overrideLogger(false);
class ObservedPublisher extends OutboxPublisherWorker {
  protected override async markPublished(id: string, token: string) {
    console.log(JSON.stringify({ checkpoint: 'sent', pid: process.pid, id }));
    if (process.argv[2] === 'pause')
      await new Promise<never>(() => {
        setInterval(() => {}, 1000);
      });
    await super.markPublished(id, token);
    console.log(JSON.stringify({ checkpoint: 'marked', pid: process.pid, id }));
  }
}
const orm = await MikroORM.init({
  ...config,
  migrations: { ...config.migrations, snapshot: false },
});
const sqs = new SqsInfrastructureClient();
const publisher = new ObservedPublisher(orm.em.fork(), sqs, new MetricsService());
process.once('SIGTERM', async () => {
  await publisher.stop();
  sqs.onModuleDestroy();
  await orm.close(true);
  process.exit(0);
});
publisher.start();

import { Logger } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import type { Message } from '@aws-sdk/client-sqs';
import config from '../../src/infrastructure/database/mikro-orm.config';
import { WagerProcessingService } from '../../src/application/wager-processing.service';
import { WagerTransactionConsumer } from '../../src/infrastructure/workers/wager-transaction.consumer';

// This fixture is outside src/dist and excluded from the application image.
// No environment switch or pause branch exists in the production consumer.
const run = process.env.INBOX_ACK_TEST_RUN_ID;
const mode = process.argv[2];
const loopback = (value: string | undefined) =>
  ['localhost', '127.0.0.1', '::1'].includes(value ?? '');
const endpoint = new URL(process.env.SQS_ENDPOINT ?? 'https://invalid.invalid');
const queue = new URL(process.env.SQS_QUEUE_URL ?? 'https://invalid.invalid');
if (
  process.env.NODE_ENV !== 'test' ||
  !run ||
  !/^[a-f0-9]{32}$/.test(run) ||
  process.env.DB_NAME !== `jungle_ack_test_${run}` ||
  !loopback(process.env.DB_HOST) ||
  !loopback(endpoint.hostname) ||
  endpoint.protocol !== 'http:' ||
  !(loopback(queue.hostname) || queue.hostname.endsWith('.localhost.localstack.cloud')) ||
  !queue.pathname.endsWith(`/ack-${run}.fifo`) ||
  !['pause', 'resume'].includes(mode ?? '') ||
  process.env.AWS_ACCESS_KEY_ID !== 'test' ||
  process.env.AWS_SECRET_ACCESS_KEY !== 'test'
)
  throw new Error('TEST_FIXTURE_REQUIRES_ISOLATED_LOCAL_TARGETS');
Logger.overrideLogger(false);

class ObservedConsumer extends WagerTransactionConsumer {
  protected override async acknowledgeMessage(message: Message): Promise<void> {
    console.log(
      JSON.stringify({
        checkpoint: 'before-ack',
        pid: process.pid,
        brokerMessageId: message.MessageId,
        receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? 0),
      }),
    );
    if (mode === 'pause') await new Promise<never>(() => {});
    await super.acknowledgeMessage(message);
    console.log(
      JSON.stringify({ checkpoint: 'acked', pid: process.pid, brokerMessageId: message.MessageId }),
    );
  }
}
async function main() {
  const orm = await MikroORM.init({
    ...config,
    migrations: { ...config.migrations, snapshot: false },
  });
  const consumer = new ObservedConsumer(new WagerProcessingService(orm.em.fork()));
  process.once('SIGTERM', async () => {
    await consumer.onModuleDestroy();
    await orm.close(true);
    process.exit(0);
  });
  consumer.start();
  console.log(JSON.stringify({ checkpoint: 'ready', pid: process.pid }));
}
main().catch(() => {
  console.error('INBOX_ACK_TEST_WORKER_FAILED');
  process.exitCode = 1;
});

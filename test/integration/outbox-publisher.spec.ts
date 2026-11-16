import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import mikroOrmConfig from '../../src/infrastructure/database/mikro-orm.config';
import { MetricsService } from '../../src/infrastructure/telemetry/metrics.service';
import { OutboxPublisherWorker } from '../../src/infrastructure/workers/outbox-publisher.worker';
import { SqsInfrastructureClient } from '../../src/infrastructure/workers/sqs-infrastructure.client';
import { OutboxOrmEntity } from '../../src/infrastructure/database/mikro-orm/entities';

const describeIntegration = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;

describeIntegration('transactional outbox publisher with PostgreSQL', () => {
  let orm: MikroORM;
  let em: ReturnType<MikroORM['em']['fork']>;

  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);
    await orm.getMigrator().up();
  });

  beforeEach(() => {
    em = orm.em.fork();
  });

  afterEach(async () => {
    await em.getConnection().execute('truncate table message_quarantine, outbox_messages cascade');
    em.clear();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  async function seedOutbox() {
    const id = randomUUID();
    const aggregateId = randomUUID();
    em.create(OutboxOrmEntity, {
      id,
      aggregateId,
      eventType: 'WagerTransactionProcessed',
      payload: { eventId: `event-${id}`, eventType: 'WagerTransactionProcessed' },
      attempts: 0,
    });
    await em.flush();
    return { id, aggregateId };
  }

  function worker(
    publishEvent: (payload: Record<string, unknown>, aggregateId: string) => Promise<void>,
    manager = em,
  ) {
    return new OutboxPublisherWorker(
      manager,
      { publishEvent } as unknown as SqsInfrastructureClient,
      new MetricsService(),
    );
  }

  it('claims and publishes due rows, then marks them published', async () => {
    const row = await seedOutbox();
    const sent: Array<{ payload: Record<string, unknown>; aggregateId: string }> = [];
    const publisher = worker(async (payload, aggregateId) => {
      sent.push({ payload, aggregateId });
    });

    await expect(publisher.runOnce()).resolves.toEqual({ claimed: 1, published: 1, failed: 0 });
    const persisted = await em.getConnection().execute<
      Array<{
        attempts: number;
        published_at: Date | null;
        claim_token: string | null;
        claimed_until: Date | null;
      }>
    >('select attempts, published_at, claim_token, claimed_until from outbox_messages where id = ?', [row.id]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.aggregateId).toBe(row.aggregateId);
    expect(sent[0]?.payload.eventId).toBe(`event-${row.id}`);
    expect(persisted[0]).toMatchObject({ attempts: 1 });
    expect(persisted[0]?.published_at).toBeTruthy();
    expect(persisted[0]?.claim_token).toBeNull();
    expect(persisted[0]?.claimed_until).toBeNull();
  });

  it('allows only one concurrent publisher to claim a row', async () => {
    await seedOutbox();
    let sends = 0;
    const send = async () => {
      sends += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
    };
    const secondEm = orm.em.fork();
    const [first, second] = await Promise.all([worker(send), worker(send, secondEm)]);
    const results = await Promise.all([first.runOnce(), second.runOnce()]);

    expect(results[0].claimed + results[1].claimed).toBe(1);
    expect(sends).toBe(1);
    secondEm.clear();
  });

  it('releases a failed claim and schedules a delayed retry', async () => {
    const row = await seedOutbox();
    const publisher = worker(async () => {
      throw new Error('simulated SQS failure');
    });

    await expect(publisher.runOnce()).resolves.toEqual({ claimed: 1, published: 0, failed: 1 });
    const persisted = await em.getConnection().execute<
      Array<{
        attempts: number;
        next_attempt_at: Date | null;
        claim_token: string | null;
        claimed_until: Date | null;
      }>
    >('select attempts, next_attempt_at, claim_token, claimed_until from outbox_messages where id = ?', [row.id]);
    expect(persisted[0]).toMatchObject({ attempts: 1 });
    expect(persisted[0]?.next_attempt_at).toBeTruthy();
    expect(persisted[0]?.claim_token).toBeNull();
    expect(persisted[0]?.claimed_until).toBeNull();
  });

  it('recovers after a crash-equivalent failure between SQS send and published mark', async () => {
    const row = await seedOutbox();
    let sends = 0;
    const publisher = worker(async () => {
      sends += 1;
      if (sends === 1) throw new Error('process crashed after send');
    });

    await expect(publisher.runOnce()).resolves.toMatchObject({ claimed: 1, failed: 1 });
    await em
      .getConnection()
      .execute('update outbox_messages set next_attempt_at = now() where id = ?', [row.id]);
    await expect(publisher.runOnce()).resolves.toEqual({ claimed: 1, published: 1, failed: 0 });

    const persisted = await em
      .getConnection()
      .execute<Array<{ published_at: Date | null; attempts: number }>>(
        'select published_at, attempts from outbox_messages where id = ?',
        [row.id],
      );
    expect(sends).toBe(2);
    expect(persisted[0]?.published_at).toBeTruthy();
    expect(persisted[0]?.attempts).toBe(2);
  });
});

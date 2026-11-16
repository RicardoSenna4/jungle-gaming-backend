import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { oidcHttpFixture } from '../helpers/oidc-http-fixture';
import { nodeApi } from '../helpers/node-api';
import { WagerProcessingService } from '../../src/application/wager-processing.service';
import { WagerTransactionConsumer } from '../../src/infrastructure/workers/wager-transaction.consumer';

const describeIntegration =
  process.env.RUN_INTEGRATION === '1' && process.env.RUN_SQS_REAL === '1'
    ? describe
    : describe.skip;
const claims = { roles: ['admin'], scope: 'quarantine:read quarantine:resolve quarantine:redrive' };
const consumer = 'wager-transaction-consumer-v1';

describeIntegration(
  'Quarantine pagination and durable manual redrive (PostgreSQL/LocalStack)',
  () => {
    let f: Awaited<ReturnType<typeof oidcHttpFixture>>;
    let sqs: SQSClient;
    let queue: string;
    let oldQueue: string | undefined;
    beforeAll(async () => {
      f = await oidcHttpFixture();
      sqs = new SQSClient({
        region: process.env.AWS_REGION ?? 'us-east-1',
        endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      });
      oldQueue = process.env.SQS_QUEUE_URL;
    });
    beforeEach(async () => {
      queue = (
        await sqs.send(
          new CreateQueueCommand({
            QueueName: `redrive-${randomUUID()}.fifo`,
            Attributes: {
              FifoQueue: 'true',
              ContentBasedDeduplication: 'false',
              VisibilityTimeout: '2',
            },
          }),
        )
      ).QueueUrl!;
      process.env.SQS_QUEUE_URL = queue;
      for (const action of ['quarantine.read', 'quarantine.resolve', 'quarantine.redrive'] as const)
        await f.store.grant(
          { kind: 'operator', issuer: f.issuer, subject: 'subject-redriver', action },
          f.actor,
        );
    });
    afterEach(async () => {
      await f.clear();
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queue }));
      process.env.SQS_QUEUE_URL = oldQueue;
    });
    afterAll(async () => {
      sqs.destroy();
      await f.close();
    });
    async function seed(id = 'source') {
      const wallet = await f.wallet();
      const raw = JSON.stringify({
        messageId: randomUUID(),
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: {
          ...wallet,
          providerId: 'provider-a',
          externalTransactionId: randomUUID(),
          idempotencyKey: randomUUID(),
          roundId: 'round',
          gameId: 'game',
          kind: 'BET',
          money: { amount: '10.00', currency: 'BRL' },
        },
      });
      await f.app
        .get(WagerProcessingService)
        .quarantineMessage(consumer, id, 'INFRASTRUCTURE_PERMANENT', raw, 1);
      return { wallet, raw };
    }
    const path = (id = 'source') => `/operations/quarantine/${consumer}/${id}/redrive`;
    const redrive = (key: string, id = 'source') =>
      f.http(
        path(id),
        'redriver',
        'POST',
        { justification: 'approved investigation' },
        key,
        claims,
      );
    async function receive() {
      return (
        (
          await sqs.send(
            new ReceiveMessageCommand({
              QueueUrl: queue,
              WaitTimeSeconds: 1,
              MaxNumberOfMessages: 10,
            }),
          )
        ).Messages ?? []
      );
    }

    it('paginates stable administrative filters and enforces the separate redrive permission', async () => {
      await seed('first');
      await seed('second');
      const first = await f.http(
        `/operations/quarantine/page?consumer=${consumer}&status=OPEN&limit=1`,
        'redriver',
        'GET',
        undefined,
        undefined,
        claims,
      );
      expect(first.status).toBe(200);
      expect(first.body.items).toHaveLength(1);
      expect(first.body.nextCursor).toBeString();
      const second = await f.http(
        `/operations/quarantine/page?consumer=${consumer}&status=OPEN&limit=1&cursor=${first.body.nextCursor}`,
        'redriver',
        'GET',
        undefined,
        undefined,
        claims,
      );
      expect(second.body.items).toHaveLength(1);
      expect(second.body.items).not.toEqual(first.body.items);
      expect(JSON.stringify(first.body)).not.toContain('raw_payload');
      expect(
        (
          await f.http(
            path('first'),
            'provider-b',
            'POST',
            { justification: 'forged' },
            'x',
            claims,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await f.http(path('first'), 'redriver', 'POST', { justification: 'forged' }, 'x', {
            roles: ['admin'],
            scope: 'quarantine:resolve',
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await f.http(
            '/operations/quarantine/page?cursor=invalid',
            'redriver',
            'GET',
            undefined,
            undefined,
            claims,
          )
        ).status,
      ).toBe(400);
    });

    it('serializes concurrent redrives and deduplicates real duplicate SQS delivery financially', async () => {
      const { wallet, raw } = await seed();
      const key = randomUUID();
      const results = await Promise.all(Array.from({ length: 4 }, () => redrive(key)));
      expect(results.some((result) => result.status === 201)).toBe(true);
      for (const result of results) expect([201, 409]).toContain(result.status);
      const history = await f.http(
        `/operations/quarantine/${consumer}/source/redrives`,
        'redriver',
        'GET',
        undefined,
        undefined,
        claims,
      );
      expect(history.status).toBe(200);
      expect(history.body.attempts).toHaveLength(1);
      expect(JSON.stringify(history.body)).not.toContain('payload');
      const replay = await redrive(key);
      expect(replay.status).toBe(201);
      expect(replay.body.replay).toBe(true);
      expect(
        await f.orm.em.getConnection().execute('select id from quarantine_redrive_attempts'),
      ).toHaveLength(1);
      const messages = await receive();
      expect(messages).toHaveLength(1);
      const handler = f.app.get(WagerTransactionConsumer);
      const original = await handler.handleMessage(messages[0]!);
      expect(original.acknowledged).toBe(true);
      await sqs.send(
        new DeleteMessageCommand({ QueueUrl: queue, ReceiptHandle: messages[0]!.ReceiptHandle }),
      );
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queue,
          MessageBody: raw,
          MessageGroupId: wallet.walletId,
          MessageDeduplicationId: randomUUID(),
        }),
      );
      const duplicate = await receive();
      expect(duplicate).toHaveLength(1);
      expect((await handler.handleMessage(duplicate[0]!)).transactionId).toBe(
        original.transactionId,
      );
      expect((await f.http(`/wallets/${wallet.walletId}`)).body).toMatchObject({
        balance: { amount: '90.00' },
        version: 2,
      });
      expect((await f.http(`/wallets/${wallet.walletId}/ledger`)).body.items).toHaveLength(2);
      expect(
        await f.orm.em.getConnection().execute('select message_id from inbox_messages'),
      ).toHaveLength(1);
    });

    it('records a real send failure as OPEN/FAILED and permits a new explicitly authorized attempt', async () => {
      await seed();
      const key = randomUUID();
      process.env.SQS_QUEUE_URL = 'http://localhost:4566/000000000000/missing-redrive-queue.fifo';
      expect((await redrive(key)).status).toBe(503);
      expect((await redrive(key)).status).toBe(503);
      expect(
        await f.orm.em
          .getConnection()
          .execute('select state,error_code from quarantine_redrive_attempts'),
      ).toEqual([{ state: 'FAILED', error_code: 'SQS_SEND_FAILED' }]);
      process.env.SQS_QUEUE_URL = queue;
      expect((await redrive(randomUUID())).status).toBe(201);
      expect(await receive()).toHaveLength(1);
    });

    it('does not send if claim persistence fails', async () => {
      await seed();
      await f.orm.em
        .getConnection()
        .execute(
          "create function redrive_test_claim_failure() returns trigger language plpgsql as $$ begin raise exception 'claim database unavailable'; end $$; create trigger redrive_test_claim_failure before insert on quarantine_redrive_attempts for each row execute function redrive_test_claim_failure();",
        );
      try {
        expect((await redrive(randomUUID())).status).toBe(503);
        expect(await receive()).toHaveLength(0);
        expect(
          await f.orm.em.getConnection().execute('select id from quarantine_redrive_attempts'),
        ).toHaveLength(0);
      } finally {
        await f.orm.em
          .getConnection()
          .execute(
            'drop trigger redrive_test_claim_failure on quarantine_redrive_attempts; drop function redrive_test_claim_failure();',
          );
      }
    });

    it('recovers an uncertain publish from a fresh Node API process with the same durable attempt identity', async () => {
      await seed();
      const key = randomUUID();
      await f.orm.em
        .getConnection()
        .execute(
          "create function redrive_test_result_failure() returns trigger language plpgsql as $$ begin if NEW.state = 'SENT' then raise exception 'result database unavailable'; end if; return NEW; end $$; create trigger redrive_test_result_failure before update on quarantine_redrive_attempts for each row execute function redrive_test_result_failure();",
        );
      try {
        const result = await redrive(key);
        expect(result.status).toBe(503);
        expect(result.body.errorCode).toBe('REDRIVE_RESULT_UNKNOWN');
      } finally {
        await f.orm.em
          .getConnection()
          .execute(
            'drop trigger redrive_test_result_failure on quarantine_redrive_attempts; drop function redrive_test_result_failure();',
          );
      }
      expect(
        (
          await f.http(
            `/operations/quarantine/${consumer}/source/resolve`,
            'redriver',
            'POST',
            { note: 'must not cancel publication' },
            undefined,
            claims,
          )
        ).status,
      ).toBe(409);
      await f.orm.em
        .getConnection()
        .execute(
          "update quarantine_redrive_attempts set lease_until = clock_timestamp()-interval '1 second'",
        );
      const child = await nodeApi();
      try {
        expect(child.pid).not.toBe(process.pid);
        const response = await fetch(child.url + path(), {
          method: 'POST',
          headers: {
            authorization: `Bearer ${f.token('redriver', claims)}`,
            'content-type': 'application/json',
            'idempotency-key': key,
          },
          body: JSON.stringify({ justification: 'recover uncertain publication' }),
        });
        expect(response.status).toBe(201);
      } finally {
        await child.close();
      }
      expect(await receive()).toHaveLength(1); // FIFO dedup uses the original durable attempt UUID.
      expect(
        await f.orm.em.getConnection().execute('select state from quarantine_redrive_attempts'),
      ).toEqual([{ state: 'SENT' }]);
      const events = await f.orm.em
        .getConnection()
        .execute('select event from quarantine_operation_events order by occurred_at');
      expect(events).toEqual([{ event: 'CLAIMED' }, { event: 'RESUMED' }, { event: 'PUBLISHED' }]);
    });

    it('keeps disposition separate from reprocessing and never repairs malformed raw payload implicitly', async () => {
      await f.app
        .get(WagerProcessingService)
        .quarantineMessage(consumer, 'invalid', 'INVALID_MESSAGE', '{broken', 1);
      expect((await redrive(randomUUID(), 'invalid')).status).toBe(422);
      expect(
        (
          await f.http(
            `/operations/quarantine/${consumer}/invalid/resolve`,
            'redriver',
            'POST',
            {},
            undefined,
            claims,
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await f.http(
            `/operations/quarantine/${consumer}/invalid/resolve`,
            'redriver',
            'POST',
            { note: 'source must issue corrected command' },
            undefined,
            claims,
          )
        ).status,
      ).toBe(201);
      expect((await redrive(randomUUID(), 'invalid')).status).toBe(409);
      expect(await receive()).toHaveLength(0);
      const events = await f.orm.em
        .getConnection()
        .execute('select actor_subject,event,justification from quarantine_operation_events');
      expect(events).toEqual([
        {
          actor_subject: 'subject-redriver',
          event: 'RESOLVED',
          justification: 'source must issue corrected command',
        },
      ]);
    });
  },
);

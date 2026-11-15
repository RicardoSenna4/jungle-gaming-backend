import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

/**
 * Disposable-environment smoke: actual Compose container startup, SQL persistence,
 * HTTP and SQS entry points, outbox publication, SIGKILL, SIGTERM and recovery.
 *
 * NEVER run this against shared environments: it drains the local events queue
 * and intentionally terminates the Compose api container.
 */
if (process.env.SMOKE_ALLOW_DISRUPTION !== '1') {
  throw new Error('SMOKE_ALLOW_DISRUPTION=1 is required for disruptive smoke testing');
}

const base = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:3000';
const endpoint = process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566';
const account = '000000000000';
const commandsQueue = `${endpoint}/${account}/wager-transactions.fifo`;
const eventsQueue = `${endpoint}/${account}/wager-events.fifo`;
const sqs = new SQSClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
  endpoint,
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

type Wallet = {
  id: string;
  version: number;
  balance: { amount: string; currency: string };
};

type Wager = {
  transactionId: string;
  status: string;
  balance: { amount: string; currency: string };
  idempotentReplay: boolean;
};

type LedgerPage = { items: Array<{ id: string }>; nextCursor?: string };
type Reconciliation = { consistent: boolean; calculatedBalance: { amount: string } };

async function request<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    signal: AbortSignal.timeout(5_000),
  });
  const raw = await response.text();
  return { status: response.status, body: JSON.parse(raw) as T };
}

async function pollUntil(
  label: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 45_000,
): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `${label} did not become true within ${timeoutMs}ms` +
      (lastError instanceof Error ? `: ${lastError.name}` : ''),
  );
}

function docker(...args: string[]): void {
  execFileSync('docker', ['compose', ...args], { stdio: 'inherit' });
}

async function waitForReady(): Promise<void> {
  await pollUntil(
    'API readiness',
    async () => {
      const live = await request<{ status: string }>('/health/live');
      if (live.status !== 200 || live.body.status !== 'ok') return false;
      const ready = await request<{ status: string }>('/health/ready');
      return ready.status === 200 && ready.body.status === 'ok';
    },
    90_000,
  );
}

function jsonPost(body: unknown, key?: string): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: JSON.stringify(body),
  };
}

async function smoke(): Promise<void> {
  await waitForReady();
  console.log('[smoke] application container is live and ready');

  const suffix = randomUUID();
  const providerId = `smoke-provider-${suffix}`;
  const playerId = `smoke-player-${suffix}`;
  const created = await request<Wallet>(
    '/wallets',
    jsonPost({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } }),
  );
  assert.equal(created.status, 201);
  assert.equal(created.body.balance.amount, '100.00');
  assert.equal(created.body.version, 1);
  const walletId = created.body.id;
  console.log('[smoke] OPENING persisted');

  const bet = {
    providerId,
    externalTransactionId: `bet-${suffix}`,
    playerId,
    walletId,
    roundId: 'smoke-round',
    gameId: 'smoke-game',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  };
  const betKey = `bet-key-${suffix}`;
  const first = await request<Wager>('/wagering/transactions', jsonPost(bet, betKey));
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'PROCESSED');
  assert.equal(first.body.balance.amount, '75.00');

  const replay = await request<Wager>('/wagering/transactions', jsonPost(bet, betKey));
  assert.equal(replay.status, 200);
  assert.equal(replay.body.idempotentReplay, true);
  assert.equal(replay.body.transactionId, first.body.transactionId);
  assert.equal(replay.body.balance.amount, '75.00');

  const winExternalId = `win-${suffix}`;
  const winMessage = {
    messageId: winExternalId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      ...bet,
      externalTransactionId: winExternalId,
      idempotencyKey: `win-key-${suffix}`,
      kind: 'WIN',
      money: { amount: '10.00', currency: 'BRL' },
    },
  };
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: commandsQueue,
      MessageBody: JSON.stringify(winMessage),
      MessageGroupId: walletId,
      MessageDeduplicationId: winExternalId,
    }),
  );
  await pollUntil('WIN processed by SQS consumer', async () => {
    const result = await request<{ status: string }>(
      `/providers/${providerId}/wagering/transactions/${winExternalId}`,
    );
    return result.status === 200 && result.body.status === 'PROCESSED';
  });
  const walletAfterWin = await request<Wallet>(`/wallets/${walletId}`);
  assert.equal(walletAfterWin.body.balance.amount, '85.00');
  const ledger = await request<LedgerPage>(`/wallets/${walletId}/ledger`);
  assert.equal(ledger.body.items.length, 3);
  const recon = await request<Reconciliation>(`/wallets/${walletId}/reconciliation`, {
    method: 'POST',
  });
  assert.equal(recon.body.consistent, true);
  assert.equal(recon.body.calculatedBalance.amount, '85.00');
  console.log('[smoke] HTTP + SQS + ledger + reconciliation passed');

  let published = false;
  await pollUntil(
    'BET event published from outbox to real SQS',
    async () => {
      const received = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: eventsQueue,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
        }),
      );
      for (const message of received.Messages ?? []) {
        if (message.Body) {
          const event = JSON.parse(message.Body) as {
            eventId?: unknown;
            aggregateId?: unknown;
            version?: unknown;
          };
          if (event.aggregateId === first.body.transactionId) {
            assert.equal(typeof event.eventId, 'string');
            assert.equal(event.version, 1);
            published = true;
          }
        }
        if (message.ReceiptHandle) {
          await sqs.send(
            new DeleteMessageCommand({
              QueueUrl: eventsQueue,
              ReceiptHandle: message.ReceiptHandle,
            }),
          );
        }
      }
      return published;
    },
    30_000,
  );
  console.log('[smoke] confirmed outbox event delivered to SQS');

  docker('kill', '-s', 'SIGKILL', 'api');
  docker('up', '-d', '--no-deps', 'api');
  await waitForReady();
  const afterCrash = await request<Wallet>(`/wallets/${walletId}`);
  assert.equal(afterCrash.body.balance.amount, '85.00');
  const afterCrashLedger = await request<LedgerPage>(`/wallets/${walletId}/ledger`);
  assert.equal(afterCrashLedger.body.items.length, 3);
  const afterCrashReplay = await request<Wager>('/wagering/transactions', jsonPost(bet, betKey));
  assert.equal(afterCrashReplay.status, 200);
  assert.equal(afterCrashReplay.body.idempotentReplay, true);
  assert.equal(afterCrashReplay.body.balance.amount, '75.00');
  console.log('[smoke] SIGKILL/restart preserved balance, ledger and snapshot');

  docker('stop', '-t', '20', 'api');
  docker('up', '-d', '--no-deps', 'api');
  await waitForReady();
  const afterTerm = await request<Wallet>(`/wallets/${walletId}`);
  assert.equal(afterTerm.body.balance.amount, '85.00');
  console.log('[smoke] SIGTERM/restart completed successfully');

  console.log('[smoke] PASS: disposable Compose deployment smoke');
}

try {
  await smoke();
} finally {
  sqs.destroy();
}

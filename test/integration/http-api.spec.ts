import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import mikroOrmConfig from '../../src/infrastructure/database/mikro-orm.config';
import { AppModule } from '../../src/app.module';

const describeIntegration = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;

describeIntegration('HTTP API contracts', () => {
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let orm: MikroORM;
  let baseUrl: string;

  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);
    await orm.getMigrator().up();
    app = await NestFactory.create(AppModule);
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0);
    const address = app.getHttpServer().address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    const em = orm.em.fork();
    await em
      .getConnection()
      .execute(
        'truncate table outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets cascade',
      );
    em.clear();
  });

  afterAll(async () => {
    await app.close();
    await orm.close(true);
  });

  async function request(
    path: string,
    init?: RequestInit,
  ): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`${baseUrl}${path}`, init);
    const text = await response.text();
    const contentType = response.headers.get('content-type') ?? '';
    return {
      status: response.status,
      body: text ? (contentType.includes('json') ? JSON.parse(text) : text) : undefined,
    };
  }

  it('validates DTOs and exposes wallet, ledger, transaction and reconciliation contracts', async () => {
    const invalid = await request('/wallets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: '', initialBalance: { amount: 10, currency: 'brl' } }),
    });
    expect(invalid.status).toBe(400);

    const created = await request('/wallets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId: 'http-player',
        initialBalance: { amount: '100.00', currency: 'BRL' },
      }),
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      balance: { amount: '100.00', currency: 'BRL' },
      version: 1,
    });
    const walletId = created.body.id as string;

    const wallet = await request(`/wallets/${walletId}`);
    expect(wallet.status).toBe(200);
    expect(wallet.body).toMatchObject({
      id: walletId,
      balance: { amount: '100.00', currency: 'BRL' },
    });

    const transaction = await request('/wagering/transactions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'http-key-1' },
      body: JSON.stringify({
        providerId: 'http-provider',
        externalTransactionId: 'http-external-1',
        playerId: 'http-player',
        walletId,
        roundId: 'http-round',
        gameId: 'http-game',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      }),
    });
    expect(transaction.status).toBe(200);
    expect(transaction.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00' } });

    const replay = await request('/wagering/transactions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'http-key-1' },
      body: JSON.stringify({
        providerId: 'http-provider',
        externalTransactionId: 'http-external-1',
        playerId: 'http-player',
        walletId,
        roundId: 'http-round',
        gameId: 'http-game',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      }),
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ idempotentReplay: true, balance: { amount: '75.00' } });

    const rejected = await request('/wagering/transactions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'http-rejected' },
      body: JSON.stringify({ providerId: 'http-provider', externalTransactionId: 'http-rejected',
        playerId: 'http-player', walletId, roundId: 'http-round', gameId: 'http-game',
        kind: 'BET', money: { amount: '999.00', currency: 'BRL' } }),
    });
    expect(rejected.status).toBe(422);
    const rejectedReplay = await request('/wagering/transactions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'http-rejected' },
      body: JSON.stringify({ providerId: 'http-provider', externalTransactionId: 'http-rejected',
        playerId: 'http-player', walletId, roundId: 'http-round', gameId: 'http-game',
        kind: 'BET', money: { amount: '999.00', currency: 'BRL' } }),
    });
    expect(rejectedReplay.status).toBe(422);
    expect(rejectedReplay.body).toMatchObject({ status: 'REJECTED', idempotentReplay: true });

    const byId = await request(`/wagering/transactions/${transaction.body.transactionId}`);
    expect(byId.status).toBe(200);
    const byExternal = await request(
      '/providers/http-provider/wagering/transactions/http-external-1',
    );
    expect(byExternal.status).toBe(200);

    const ledger = await request(`/wallets/${walletId}/ledger?limit=10`);
    expect(ledger.status).toBe(200);
    expect(ledger.body.items).toHaveLength(2);

    const reconciliation = await request(`/wallets/${walletId}/reconciliation`, { method: 'POST' });
    expect(reconciliation.status).toBe(200);
    expect(reconciliation.body).toMatchObject({
      consistent: true,
      calculatedBalance: { amount: '75.00' },
    });

    const missingKey = await request('/wagering/transactions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(missingKey.status).toBe(400);
  });

  it('returns health and readiness responses with dependency status', async () => {
    const live = await request('/health/live');
    expect(live).toEqual({ status: 200, body: { status: 'ok' } });
    const ready = await request('/health/ready');
    expect([200, 503]).toContain(ready.status);
    expect(ready.body).toHaveProperty('status');
    const metrics = await request('/metrics');
    expect(metrics.status).toBe(200);
  });
});

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { AppModule } from '../../src/app.module';
import { WagerProcessingService } from '../../src/application/wager-processing.service';
import mikroOrmConfig from '../../src/infrastructure/database/mikro-orm.config';

const describeIntegration = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;

// Task 1 characterizes the current boundary, including known vulnerabilities.
// AUDIT GAP assertions describe exposure, NOT the future authorization contract.
// Replace these assertions with the ADR-019 denial cases when enforcement ships.
describeIntegration('Provider authorization audit (real HTTP, RS256/JWKS and PostgreSQL)', () => {
  const originalEnv = { ...process.env };
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let jwks: Server;
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let orm: MikroORM;
  let baseUrl: string;

  beforeAll(async () => {
    jwks = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'audit-key', use: 'sig' }],
        }),
      );
    });
    await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve));
    const address = jwks.address();
    if (!address || typeof address === 'string') throw new Error('JWKS listener unavailable');
    Object.assign(process.env, {
      AUTH_MODE: 'oidc',
      OIDC_ISSUER_URL: `http://127.0.0.1:${address.port}`,
      OIDC_JWKS_URI: `http://127.0.0.1:${address.port}/keys`,
      OIDC_AUDIENCE: 'authorization-audit',
      OIDC_PROVIDER_ID_CLAIM: 'providerId',
      ENABLE_SQS_CONSUMER: 'false',
      ENABLE_OUTBOX_PUBLISHER: 'false',
      ENABLE_PENDING_REFERENCE_WORKER: 'false',
    });
    orm = await MikroORM.init(mikroOrmConfig);
    await orm.getMigrator().up();
    app = await NestFactory.create(AppModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    const apiAddress = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${apiAddress.port}`;
  });

  afterEach(async () => {
    await orm.em
      .getConnection()
      .execute(
        'truncate table message_quarantine, outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets cascade',
      );
  });

  afterAll(async () => {
    await app?.close();
    await orm?.close(true);
    if (jwks) await new Promise<void>((resolve) => jwks.close(() => resolve()));
    process.env = { ...originalEnv };
  });

  function token(providerId: string): string {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'audit-key' })).toString(
      'base64url',
    );
    const payload = Buffer.from(
      JSON.stringify({
        iss: process.env.OIDC_ISSUER_URL,
        aud: 'authorization-audit',
        sub: `subject-${providerId}`,
        providerId,
        exp: Math.floor(Date.now() / 1_000) + 300,
      }),
    ).toString('base64url');
    const input = `${header}.${payload}`;
    const signer = createSign('RSA-SHA256');
    signer.update(input);
    return `${input}.${signer.sign(privateKey).toString('base64url')}`;
  }

  async function request(path: string, provider?: string, method = 'GET', body?: unknown) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'audit-key',
        ...(provider ? { authorization: `Bearer ${token(provider)}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  }

  async function wallet(provider = 'provider-a', playerId = 'audit-player') {
    const result = await request('/wallets', provider, 'POST', {
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    expect(result.status).toBe(201);
    return String(result.body.id);
  }

  function wager(walletId: string, providerId = 'provider-a') {
    return {
      providerId,
      playerId: 'audit-player',
      walletId,
      externalTransactionId: 'same-external-id',
      roundId: 'audit-round',
      gameId: 'audit-game',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    };
  }

  it('denies missing tokens on all business routes and keeps health public', async () => {
    for (const [path, method] of [
      ['/wallets', 'POST'],
      ['/wallets/00000000-0000-4000-8000-000000000001', 'GET'],
      ['/wallets/00000000-0000-4000-8000-000000000001/ledger', 'GET'],
      ['/wallets/00000000-0000-4000-8000-000000000001/reconciliation', 'POST'],
      ['/wagering/transactions', 'POST'],
      ['/wagering/transactions/00000000-0000-4000-8000-000000000001', 'GET'],
      ['/providers/provider-a/wagering/transactions/tx', 'GET'],
      ['/operations/quarantine', 'GET'],
      ['/operations/quarantine/consumer/message/resolve', 'POST'],
    ]) {
      const result = await request(path!, undefined, method);
      expect(result.status).toBe(401);
      expect(result.body).toMatchObject({ errorCode: 'AUTHORIZATION_REQUIRED' });
    }
    expect((await request('/health/live')).status).toBe(200);
    expect((await request('/health/ready')).body).toEqual({
      status: 'ok',
      checks: { postgres: 'up', sqs: 'up' },
    });
  });

  it('allows two authenticated providers on one wallet with independent idempotency namespaces', async () => {
    const id = await wallet();
    const a = await request('/wagering/transactions', 'provider-a', 'POST', wager(id));
    const b = await request(
      '/wagering/transactions',
      'provider-b',
      'POST',
      wager(id, 'provider-b'),
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.transactionId).not.toBe(b.body.transactionId);
    expect(b.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '80.00' } });
    const replay = await request('/wagering/transactions', 'provider-a', 'POST', wager(id));
    expect(replay.body).toMatchObject({ idempotentReplay: true, balance: { amount: '90.00' } });
    for (const provider of ['provider-a', 'provider-b']) {
      const own = await request(
        `/providers/${provider}/wagering/transactions/same-external-id`,
        provider,
      );
      expect(own.status).toBe(200);
      expect(own.body.providerId).toBe(provider);
    }
  });

  it('denies mismatched body and URL providers without persisting a wager', async () => {
    const id = await wallet();
    const rejected = await request('/wagering/transactions', 'provider-b', 'POST', wager(id));
    expect(rejected.status).toBe(403);
    expect(rejected.body).toMatchObject({ errorCode: 'PROVIDER_IDENTITY_MISMATCH' });
    expect(
      (await request('/providers/provider-a/wagering/transactions/same-external-id', 'provider-b'))
        .status,
    ).toBe(403);
    expect((await request(`/wallets/${id}`, 'provider-a')).body.balance).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    const rows = await orm.em
      .getConnection()
      .execute('select id from wager_transactions where kind = ?', ['BET']);
    expect(rows).toHaveLength(0);
  });

  it('AUDIT GAP: B reads A transaction, wallet, complete ledger and reconciliation by UUID', async () => {
    const id = await wallet();
    const a = await request('/wagering/transactions', 'provider-a', 'POST', wager(id));
    expect(a.status).toBe(200);
    const leaked = await request(`/wagering/transactions/${a.body.transactionId}`, 'provider-b');
    expect(leaked.status).toBe(200);
    expect(leaked.body).toMatchObject({ providerId: 'provider-a', walletId: id });
    expect((await request(`/wallets/${id}`, 'provider-b')).body).toMatchObject({
      playerId: 'audit-player',
      balance: { amount: '90.00' },
    });
    const ledger = await request(`/wallets/${id}/ledger?limit=1`, 'provider-b');
    expect(ledger.status).toBe(200);
    expect(ledger.body.items).toHaveLength(1);
    expect(ledger.body.nextCursor).toBeString();
    const next = await request(
      `/wallets/${id}/ledger?limit=1&cursor=${ledger.body.nextCursor}`,
      'provider-b',
    );
    expect(next.status).toBe(200);
    expect(next.body.items).toHaveLength(1);
    const reconciliation = await request(`/wallets/${id}/reconciliation`, 'provider-b', 'POST');
    expect(reconciliation.status).toBe(200);
    expect(reconciliation.body).toMatchObject({ consistent: true, checkedEntries: 2 });
  });

  it('AUDIT GAP: a matching body provider overrides a different URL provider on GET', async () => {
    const id = await wallet();
    expect((await request('/wagering/transactions', 'provider-a', 'POST', wager(id))).status).toBe(
      200,
    );
    // Bun's HTTP adapter discards GET bodies; verify the supported Node start
    // path too. Use the current build, a real Node Nest server and the same DB/JWKS.
    const nodeApi = spawn(
      'node',
      [
        '-e',
        `
      const { NestFactory } = require('@nestjs/core');
      const { ValidationPipe } = require('@nestjs/common');
      const { AppModule } = require('./dist/app.module');
      (async () => {
        const app = await NestFactory.create(AppModule, {logger: false});
        app.useGlobalPipes(new ValidationPipe({whitelist: true, transform: true}));
        await app.listen(0, '127.0.0.1');
        console.log(app.getHttpServer().address().port);
        process.on('SIGTERM', async () => { await app.close(); process.exit(0); });
      })().catch(() => process.exit(1));
    `,
      ],
      { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Node API startup timed out')), 15000);
        nodeApi.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        nodeApi.once('exit', () => {
          clearTimeout(timer);
          reject(new Error('Node API exited before readiness'));
        });
        nodeApi.stdout.once('data', (chunk: Buffer) => {
          clearTimeout(timer);
          const port = Number(chunk.toString().trim());
          if (!Number.isInteger(port) || port <= 0) reject(new Error('Invalid Node API port'));
          else resolve(port);
        });
      });
      // fetch forbids GET bodies and Bun's node:http client can discard them.
      // Use the installed Node client against the same real Nest/JWKS listeners.
      const { stdout } = await promisify(execFile)('node', [
        '-e',
        `const http = require('node:http');
       const body = JSON.stringify({providerId: 'provider-b'});
       const req = http.request(process.argv[1], {
         method: 'GET',
         headers: {authorization: 'Bearer ' + process.argv[2],
           'content-type': 'application/json', 'content-length': Buffer.byteLength(body)}
       }, res => {
         let text = '';
         res.setEncoding('utf8');
         res.on('data', chunk => { text += chunk; });
         res.on('end', () => console.log(JSON.stringify({status: res.statusCode, body: JSON.parse(text)})));
         res.on('error', () => process.exit(1));
       });
       req.on('error', () => process.exit(1));
       req.end(body);`,
        `http://127.0.0.1:${port}/providers/provider-a/wagering/transactions/same-external-id`,
        token('provider-b'),
      ]);
      const result = JSON.parse(stdout) as { status: number; body: Record<string, unknown> };
      expect(result.status).toBe(200);
      expect(result.body.providerId).toBe('provider-a');
    } finally {
      const closed = new Promise<void>((resolve) => nodeApi.once('exit', () => resolve()));
      nodeApi.kill('SIGTERM');
      await closed;
    }
  });

  it('AUDIT GAP: any provider creates a wallet for an arbitrary global player with opening credit', async () => {
    const id = await wallet('provider-b', 'not-a-provider-b-player');
    const rows = await orm.em
      .getConnection()
      .execute(
        'select provider_id, kind, amount::text from wager_transactions where wallet_id = ?',
        [id],
      );
    expect(rows).toEqual([{ provider_id: '__internal__', kind: 'OPENING', amount: '100.00' }]);
    const duplicate = await request('/wallets', 'provider-a', 'POST', {
      playerId: 'not-a-provider-b-player',
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    expect(duplicate.status).toBe(409);
  });

  it('AUDIT GAP: provider without operator privileges lists and resolves global quarantine', async () => {
    await app
      .get(WagerProcessingService)
      .quarantineMessage('audit-consumer', 'invalid-message', 'INVALID_MESSAGE', '{invalid', 1);
    const list = await request('/operations/quarantine', 'provider-b');
    expect(list.status).toBe(200);
    expect(list.body).toEqual([
      expect.objectContaining({ messageId: 'invalid-message', status: 'OPEN' }),
    ]);
    expect(JSON.stringify(list.body)).not.toContain('rawPayload');
    const resolved = await request(
      '/operations/quarantine/audit-consumer/invalid-message/resolve',
      'provider-b',
      'POST',
      { note: 'audit resolution' },
    );
    expect(resolved.status).toBe(201);
    expect(resolved.body).toMatchObject({ status: 'RESOLVED', resolutionNote: 'audit resolution' });
    const rows = await orm.em
      .getConnection()
      .execute('select status, resolution_note from message_quarantine where message_id = ?', [
        'invalid-message',
      ]);
    expect(rows).toEqual([{ status: 'RESOLVED', resolution_note: 'audit resolution' }]);
  });
});

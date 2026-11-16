import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { createServer } from 'node:http';
import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import { AppModule } from '../../src/app.module';
import config from '../../src/infrastructure/database/mikro-orm.config';
import { AuthorizationStore } from '../../src/application/authorization/authorization-store';
import { WalletCapability } from '../../src/infrastructure/database/mikro-orm/authorization.entities';

export async function oidcHttpFixture(settings: Record<string, string> = {}) {
  const original = { ...process.env };
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwks = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'http-test', use: 'sig' }],
      }),
    );
  });
  await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve));
  const address = jwks.address();
  if (!address || typeof address === 'string') throw new Error('JWKS not listening');
  const issuer = `http://127.0.0.1:${address.port}`;
  Object.assign(process.env, {
    AUTH_MODE: 'oidc',
    OIDC_ISSUER_URL: issuer,
    OIDC_JWKS_URI: `${issuer}/keys`,
    OIDC_AUDIENCE: 'financial-security-tests',
    OIDC_PROVIDER_ID_CLAIM: 'providerId',
    ENABLE_SQS_CONSUMER: 'false',
    ENABLE_OUTBOX_PUBLISHER: 'false',
    ENABLE_PENDING_REFERENCE_WORKER: 'false',
    ...settings,
  });
  const orm = await MikroORM.init(config);
  await orm.getMigrator().up();
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  const store = app.get(AuthorizationStore);
  const actor = {
    issuer: 'trusted-test-admin',
    subject: 'provisioner',
    source: 'explicit-http-fixture',
  };

  function token(name: string, claims: Record<string, unknown> = {}) {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'http-test' })).toString(
      'base64url',
    );
    const payload = Buffer.from(
      JSON.stringify({
        iss: issuer,
        aud: 'financial-security-tests',
        sub: `subject-${name}`,
        providerId: name,
        exp: Math.floor(Date.now() / 1000) + 300,
        ...claims,
      }),
    ).toString('base64url');
    const input = `${header}.${payload}`;
    const signer = createSign('RSA-SHA256');
    signer.update(input);
    return `${input}.${signer.sign(privateKey).toString('base64url')}`;
  }

  async function http(
    path: string,
    name: string | null = 'provider-a',
    method = 'GET',
    body?: unknown,
    key = randomUUID(),
    claims: Record<string, unknown> = {},
  ) {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'idempotency-key': key,
        ...(name ? { authorization: `Bearer ${token(name, claims)}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: (response.headers.get('content-type')?.includes('json')
        ? JSON.parse(text)
        : { text }) as Record<string, unknown>,
    };
  }

  async function bind(providerId: string) {
    await store.grant(
      { kind: 'binding', issuer, subject: `subject-${providerId}`, providerId },
      actor,
    );
  }
  async function share(
    walletId: string,
    providerId: string,
    capabilities: readonly WalletCapability[],
  ) {
    await bind(providerId);
    for (const capability of capabilities)
      await store.grant({ kind: 'wallet', providerId, walletId, capability }, actor);
  }
  async function wallet(
    providerId = 'provider-a',
    capabilities: readonly WalletCapability[] = [
      'balance.read',
      'wager.submit',
      'transaction.read_own',
      'ledger.read_all',
      'reconcile',
    ],
  ) {
    await bind(providerId);
    const playerId = randomUUID();
    for (const capability of ['wallet.create', 'wallet.opening.credit'] as const)
      await store.grant(
        { kind: 'player', providerId, playerId, currency: 'BRL', capability },
        actor,
      );
    const created = await http('/wallets', providerId, 'POST', {
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    if (created.status !== 201) throw new Error(`Wallet fixture failed: ${created.status}`);
    const walletId = String(created.body.id);
    await share(walletId, providerId, capabilities);
    return { walletId, playerId };
  }
  async function clear() {
    await orm.em
      .getConnection()
      .execute(
        'truncate table authorization_audit, provider_principal_bindings, provider_player_grants, operator_grants, message_quarantine, inbox_messages, outbox_messages, wallet_ledger_entries, wager_transactions, wallets cascade',
      );
  }
  async function close() {
    try {
      await app.close();
      await orm.close(true);
      await new Promise<void>((resolve) => jwks.close(() => resolve()));
    } finally {
      process.env = { ...original };
    }
  }
  return { orm, app, store, actor, issuer, url, token, http, bind, share, wallet, clear, close };
}

import { Client } from 'pg';
import { oidcHttpFixture } from '../helpers/oidc-http-fixture';

const describeIntegration = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;

describeIntegration('Financial endpoint resource authorization over real HTTP', () => {
  let fixture: Awaited<ReturnType<typeof oidcHttpFixture>>;
  beforeAll(async () => {
    fixture = await oidcHttpFixture();
  });
  afterEach(async () => {
    await fixture.clear();
  });
  afterAll(async () => {
    await fixture.close();
  });

  function wager(
    wallet: { walletId: string; playerId: string },
    providerId: string,
    kind: string,
    externalTransactionId: string,
    amount = '10.00',
    reference?: string,
  ) {
    return {
      ...wallet,
      providerId,
      kind,
      externalTransactionId,
      roundId: 'shared-round',
      gameId: 'shared-game',
      money: { amount, currency: 'BRL' },
      ...(reference ? { referenceExternalTransactionId: reference } : {}),
    };
  }

  it('requires JWT and explicit grants on every financial endpoint, including exclusive and shared wallets', async () => {
    const a = await fixture.wallet();
    const b = await fixture.wallet('provider-b');
    const tx = await fixture.http(
      '/wagering/transactions',
      'provider-a',
      'POST',
      wager(a, 'provider-a', 'BET', 'a-bet'),
    );
    expect(tx.status).toBe(200);
    const paths = [
      [
        '/wallets',
        'POST',
        { playerId: a.playerId, initialBalance: { amount: '0.00', currency: 'BRL' } },
      ],
      [`/wallets/${a.walletId}`, 'GET'],
      [`/wallets/${a.walletId}/ledger`, 'GET'],
      [`/wallets/${a.walletId}/reconciliation`, 'POST'],
      ['/wagering/transactions', 'POST', wager(a, 'provider-b', 'BET', 'forbidden-bet')],
      [`/wagering/transactions/${tx.body.transactionId}`, 'GET'],
      ['/providers/provider-a/wagering/transactions/a-bet', 'GET'],
    ] as const;
    for (const [path, method, body] of paths) {
      expect((await fixture.http(path, null, method, body)).status).toBe(401);
      expect((await fixture.http(path, 'provider-b', method, body)).status).toBe(
        path.startsWith('/providers/') ? 403 : 404,
      );
    }
    expect((await fixture.http(`/wallets/${b.walletId}`, 'provider-b')).status).toBe(200);
    expect((await fixture.http(`/wallets/${b.walletId}`, 'provider-a')).status).toBe(404);
    await fixture.share(a.walletId, 'provider-b', ['balance.read']);
    expect((await fixture.http(`/wallets/${a.walletId}`, 'provider-b')).status).toBe(200);
    expect((await fixture.http(`/wallets/${a.walletId}/ledger`, 'provider-b')).status).toBe(404);
    expect(
      (await fixture.http(`/wallets/${a.walletId}/reconciliation`, 'provider-b', 'POST')).status,
    ).toBe(404);
    expect(
      (await fixture.http(`/wagering/transactions/${tx.body.transactionId}`, 'provider-b')).status,
    ).toBe(404);
    expect(
      (
        await fixture.http(`/wallets/${a.walletId}`, 'provider-a', 'GET', undefined, undefined, {
          iss: 'https://other-issuer.test',
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fixture.http(`/wallets/${a.walletId}`, 'provider-a', 'GET', undefined, undefined, {
          sub: 'another-subject',
        })
      ).status,
    ).toBe(403);
  });

  it('authorizes all five financial operations without changing Money, references, ledger or reconciliation', async () => {
    const wallet = await fixture.wallet();
    await fixture.bind('provider-b');
    const operations = [
      ['BET', 'bet', '10.00', undefined],
      ['WIN', 'win', '5.00', undefined],
      ['LOSS', 'loss', '1.00', undefined],
      ['REFUND', 'refund', '10.00', 'bet'],
      ['ROLLBACK', 'rollback', '5.00', 'win'],
    ] as const;
    for (const [kind, external, amount, reference] of operations) {
      const denied = await fixture.http(
        '/wagering/transactions',
        'provider-b',
        'POST',
        wager(wallet, 'provider-b', kind, external, amount, reference),
      );
      expect(denied.status).toBe(404);
      const allowed = await fixture.http(
        '/wagering/transactions',
        'provider-a',
        'POST',
        wager(wallet, 'provider-a', kind, external, amount, reference),
      );
      expect(allowed.status).toBe(200);
      expect(allowed.body.status).toBe('PROCESSED');
      expect(
        (await fixture.http(`/wagering/transactions/${allowed.body.transactionId}`, 'provider-a'))
          .status,
      ).toBe(200);
      expect(
        (
          await fixture.http(
            `/providers/provider-a/wagering/transactions/${external}`,
            'provider-a',
          )
        ).status,
      ).toBe(200);
    }
    const current = await fixture.http(`/wallets/${wallet.walletId}`);
    expect(current.body).toMatchObject({
      balance: { amount: '100.00', currency: 'BRL' },
      version: 5,
    });
    expect((await fixture.http(`/wallets/${wallet.walletId}/ledger`)).body.items).toHaveLength(5);
    expect(
      (await fixture.http(`/wallets/${wallet.walletId}/reconciliation`, 'provider-a', 'POST')).body,
    ).toMatchObject({ consistent: true, difference: { amount: '0.00' } });
    const foreignRows = await fixture.orm.em
      .getConnection()
      .execute("select id from wager_transactions where provider_id = 'provider-b'");
    expect(foreignRows).toHaveLength(0);
  });

  it('serializes two authorized providers competing for one balance and preserves concurrent replay snapshots', async () => {
    const wallet = await fixture.wallet();
    await fixture.share(wallet.walletId, 'provider-b', ['wager.submit', 'transaction.read_own']);
    const inputs = ['provider-a', 'provider-b'].map((provider) =>
      wager(wallet, provider, 'BET', `race-${provider}`, '80.00'),
    );
    const results = await Promise.all(
      inputs.map((input) =>
        fixture.http(
          '/wagering/transactions',
          input.providerId,
          'POST',
          input,
          `race-${input.providerId}`,
        ),
      ),
    );
    expect(results.map((result) => result.status).sort()).toEqual([200, 422]);
    expect((await fixture.http(`/wallets/${wallet.walletId}`)).body).toMatchObject({
      balance: { amount: '20.00' },
    });
    expect((await fixture.http(`/wallets/${wallet.walletId}/ledger`)).body.items).toHaveLength(2);
    const winner = results.findIndex((result) => result.status === 200);
    const replays = await Promise.all(
      Array.from({ length: 12 }, () =>
        fixture.http(
          '/wagering/transactions',
          inputs[winner]!.providerId,
          'POST',
          inputs[winner],
          `race-${inputs[winner]!.providerId}`,
        ),
      ),
    );
    for (const replay of replays)
      expect(replay.body).toMatchObject({
        transactionId: results[winner]!.body.transactionId,
        idempotentReplay: true,
        balance: { amount: '20.00' },
      });
    const counts = await fixture.orm.em
      .getConnection()
      .execute(
        "select status, count(*)::integer as count from wager_transactions where kind = 'BET' group by status order by status",
      );
    expect(counts).toEqual([
      { status: 'PROCESSED', count: 1 },
      { status: 'REJECTED', count: 1 },
    ]);
  });

  it('denies an HTTP wager waiting behind grant revocation without financial or outbox effects', async () => {
    const wallet = await fixture.wallet();
    const db = new Client({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USER ?? 'postgres',
      password: process.env.DB_PASSWORD ?? 'postgres',
      database: process.env.DB_NAME ?? 'jungle',
    });
    await db.connect();
    await db.query('begin');
    await db.query(
      "select * from provider_wallet_grants where provider_id = $1 and wallet_id = $2 and capability = 'wager.submit' for update",
      ['provider-a', wallet.walletId],
    );
    const before = await fixture.orm.em
      .getConnection()
      .execute('select count(*)::integer as count from outbox_messages');
    const pending = fixture.http(
      '/wagering/transactions',
      'provider-a',
      'POST',
      wager(wallet, 'provider-a', 'BET', 'revoked-bet'),
    );
    try {
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
        const rows = await db.query(
          'select exists(select 1 from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and cardinality(pg_blocking_pids(pid)) > 0) as blocked',
        );
        blocked = rows.rows[0].blocked;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await db.query(
        "update provider_wallet_grants set revoked_at = greatest(clock_timestamp(), granted_at), actor_issuer = 'trusted-admin', actor_subject = 'revoker', source = 'approved-revocation' where provider_id = $1 and wallet_id = $2 and capability = 'wager.submit'",
        ['provider-a', wallet.walletId],
      );
      await db.query('commit');
      expect((await pending).status).toBe(404);
      expect(
        await fixture.orm.em
          .getConnection()
          .execute('select count(*)::integer as count from outbox_messages'),
      ).toEqual(before);
      expect(
        await fixture.orm.em
          .getConnection()
          .execute("select id from wager_transactions where kind <> 'OPENING'"),
      ).toHaveLength(0);
      expect((await fixture.http(`/wallets/${wallet.walletId}`)).body).toMatchObject({
        balance: { amount: '100.00' },
        version: 1,
      });
    } finally {
      await db.query('rollback');
      await db.end();
      await pending;
    }
  });
});

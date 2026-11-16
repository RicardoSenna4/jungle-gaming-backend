import { oidcHttpFixture } from '../helpers/oidc-http-fixture';
import { WagerProcessingService } from '../../src/application/wager-processing.service';
import { JsonLogger } from '../../src/infrastructure/telemetry/json-logger';

const describeIntegration = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;
const read = { roles: ['operator'], scope: 'quarantine:read' };
const admin = { roles: ['admin'], scope: 'quarantine:read quarantine:resolve metrics:read' };

describeIntegration('Administrative roles and metrics over real RS256/JWKS HTTP', () => {
  let fixture: Awaited<ReturnType<typeof oidcHttpFixture>>;
  beforeAll(async () => {
    fixture = await oidcHttpFixture(
      {
        NODE_ENV: 'test',
        METRICS_ACCESS: 'auto',
        OIDC_ROLES_CLAIM: 'roles',
        OIDC_PERMISSIONS_CLAIM: 'scope',
        OIDC_OPERATOR_ROLES: 'operator',
        OIDC_ADMIN_ROLES: 'admin',
      },
      new JsonLogger(),
    );
  });
  afterEach(async () => {
    await fixture.clear();
  });
  afterAll(async () => {
    await fixture.close();
  });

  async function operator(
    name: string,
    actions: readonly ('quarantine.read' | 'quarantine.resolve')[],
  ) {
    for (const action of actions)
      await fixture.store.grant(
        { kind: 'operator', issuer: fixture.issuer, subject: `subject-${name}`, action },
        fixture.actor,
      );
  }
  async function message(id: string, provider: string) {
    await fixture.app
      .get(WagerProcessingService)
      .quarantineMessage(
        'shared-consumer',
        id,
        'INVALID_MESSAGE',
        JSON.stringify({ providerId: provider, secret: 'raw-sensitive-payload' }),
        1,
      );
  }

  it('denies absent tokens, provider roles, insufficient permissions and role claims without persistent delegation', async () => {
    await message('provider-a-message', 'provider-a');
    await operator('provider-b', ['quarantine.read', 'quarantine.resolve']);
    for (const path of [
      '/operations/quarantine',
      '/operations/quarantine/shared-consumer/provider-a-message/resolve',
    ]) {
      const method = path.endsWith('/resolve') ? 'POST' : 'GET';
      expect((await fixture.http(path, null, method)).status).toBe(401);
      expect(
        (
          await fixture.http(
            path,
            'provider-b',
            method,
            method === 'POST'
              ? { note: 'forged', roles: ['admin'], scope: 'quarantine:resolve' }
              : undefined,
            undefined,
            { roles: ['provider'], scope: 'quarantine:read quarantine:resolve' },
          )
        ).status,
      ).toBe(403);
      expect(
        (await fixture.http(path, 'provider-b', method, undefined, undefined, { roles: ['admin'] }))
          .status,
      ).toBe(403);
      expect(
        (await fixture.http(path, 'unprovisioned-admin', method, undefined, undefined, admin))
          .status,
      ).toBe(403);
    }
    const rows = await fixture.orm.em
      .getConnection()
      .execute(
        "select status, resolution_note from message_quarantine where message_id = 'provider-a-message'",
      );
    expect(rows).toEqual([{ status: 'OPEN', resolution_note: null }]);
  });

  it('separates read and resolve for operators and permits explicitly delegated global administrators', async () => {
    await message('a-message', 'provider-a');
    await message('b-message', 'provider-b');
    await operator('support', ['quarantine.read']);
    expect(
      (await fixture.http('/operations/quarantine', 'support', 'GET', undefined, undefined, read))
        .status,
    ).toBe(200);
    expect(
      (
        await fixture.http(
          '/operations/quarantine/shared-consumer/a-message/resolve',
          'support',
          'POST',
          { note: 'not allowed' },
          undefined,
          read,
        )
      ).status,
    ).toBe(403);
    await operator('security-admin', ['quarantine.read', 'quarantine.resolve']);
    for (const id of ['a-message', 'b-message']) {
      expect(
        (
          await fixture.http(
            `/operations/quarantine/shared-consumer/${id}/resolve`,
            'security-admin',
            'POST',
            { note: 'approved investigation' },
            undefined,
            admin,
          )
        ).status,
      ).toBe(201);
    }
    const audits = await fixture.orm.em
      .getConnection()
      .execute(
        "select actor_subject, decision from authorization_audit where action = 'quarantine.resolve' and decision = 'allow'",
      );
    expect(audits).toEqual([
      { actor_subject: 'subject-security-admin', decision: 'allow' },
      { actor_subject: 'subject-security-admin', decision: 'allow' },
    ]);
  });

  it('audits authenticated denials and resolution without tokens, claims, raw payload or notes in application logs', async () => {
    await message('sensitive-message', 'provider-a');
    await operator('security-admin', ['quarantine.resolve']);
    const lines: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((line: string | Uint8Array) => {
      lines.push(String(line));
      return true;
    }) as typeof process.stdout.write;
    const note = 'private-investigation-note';
    const token = fixture.token('security-admin', admin);
    try {
      expect(
        (
          await fixture.http(
            '/operations/quarantine/shared-consumer/sensitive-message/resolve',
            'provider-b',
            'POST',
            { note },
            undefined,
            { roles: ['provider'] },
          )
        ).status,
      ).toBe(403);
      const response = await fetch(
        `${fixture.url}/operations/quarantine/shared-consumer/sensitive-message/resolve`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ note }),
        },
      );
      expect(response.status).toBe(201);
    } finally {
      process.stdout.write = original;
    }
    const output = lines.join('');
    expect(output).toContain('administrative_authorization');
    for (const secret of [token, note, 'raw-sensitive-payload', 'Bearer ', 'quarantine:resolve'])
      expect(output).not.toContain(secret);
    const audits = await fixture.orm.em
      .getConnection()
      .execute(
        "select actor_subject, decision, resource from authorization_audit where action = 'quarantine.resolve' order by occurred_at",
      );
    expect(audits).toEqual([
      { actor_subject: 'subject-provider-b', decision: 'deny', resource: expect.any(String) },
      { actor_subject: 'subject-security-admin', decision: 'allow', resource: expect.any(String) },
    ]);
    expect(JSON.stringify(audits)).not.toContain(note);
    expect(JSON.stringify(audits)).not.toContain('raw-sensitive-payload');
  });

  it('protects external metrics with signed roles and scope, with explicit disabling and no OIDC public fallback', async () => {
    expect((await fixture.http('/metrics', null)).status).toBe(401);
    expect(
      (
        await fixture.http('/metrics', 'provider-b', 'GET', undefined, undefined, {
          roles: ['provider'],
          scope: 'metrics:read',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fixture.http('/metrics', 'security-admin', 'GET', undefined, undefined, {
          roles: ['admin'],
        })
      ).status,
    ).toBe(403);
    const allowed = await fixture.http(
      '/metrics',
      'security-admin',
      'GET',
      undefined,
      undefined,
      admin,
    );
    expect(allowed.status).toBe(200);
    expect(typeof allowed.body.text).toBe('string');
    process.env.METRICS_ACCESS = 'public';
    try {
      expect((await fixture.http('/metrics', null)).status).toBe(503);
    } finally {
      process.env.METRICS_ACCESS = 'auto';
    }
    process.env.METRICS_ACCESS = 'disabled';
    try {
      expect(
        (await fixture.http('/metrics', 'security-admin', 'GET', undefined, undefined, admin))
          .status,
      ).toBe(404);
    } finally {
      process.env.METRICS_ACCESS = 'auto';
    }
    const previous = process.env.AUTH_MODE;
    process.env.AUTH_MODE = 'challenge';
    process.env.NODE_ENV = 'production';
    try {
      expect((await fixture.http('/metrics', null)).status).toBe(404);
    } finally {
      process.env.AUTH_MODE = previous;
      process.env.NODE_ENV = 'test';
    }
    process.env.AUTH_MODE = 'challenge';
    try {
      expect((await fixture.http('/metrics', null)).status).toBe(200);
    } finally {
      process.env.AUTH_MODE = previous;
    }
    expect((await fixture.http('/health/live', null)).status).toBe(200);
  });

  it('applies configured claim names and roles and fails closed for malformed administrative settings', async () => {
    await operator('custom-admin', ['quarantine.read']);
    const previous = {
      roles: process.env.OIDC_ROLES_CLAIM,
      permissions: process.env.OIDC_PERMISSIONS_CLAIM,
      admin: process.env.OIDC_ADMIN_ROLES,
      permission: process.env.OIDC_QUARANTINE_READ_PERMISSION,
    };
    Object.assign(process.env, {
      OIDC_ROLES_CLAIM: 'realm_roles',
      OIDC_PERMISSIONS_CLAIM: 'permissions',
      OIDC_ADMIN_ROLES: 'security-admin',
      OIDC_QUARANTINE_READ_PERMISSION: 'message:inspect',
    });
    try {
      expect(
        (
          await fixture.http(
            '/operations/quarantine',
            'custom-admin',
            'GET',
            undefined,
            undefined,
            { realm_roles: ['security-admin'], permissions: ['message:inspect'] },
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await fixture.http(
            '/operations/quarantine',
            'custom-admin',
            'GET',
            undefined,
            undefined,
            admin,
          )
        ).status,
      ).toBe(403);
      process.env.OIDC_ADMIN_ROLES = '';
      expect(
        (
          await fixture.http(
            '/operations/quarantine',
            'custom-admin',
            'GET',
            undefined,
            undefined,
            admin,
          )
        ).status,
      ).toBe(503);
    } finally {
      process.env.OIDC_ROLES_CLAIM = previous.roles;
      process.env.OIDC_PERMISSIONS_CLAIM = previous.permissions;
      process.env.OIDC_ADMIN_ROLES = previous.admin;
      if (previous.permission === undefined) delete process.env.OIDC_QUARANTINE_READ_PERMISSION;
      else process.env.OIDC_QUARANTINE_READ_PERMISSION = previous.permission;
    }
  });
});

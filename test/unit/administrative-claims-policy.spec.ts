import { AdministrativeClaimsPolicy } from '../../src/application/authorization/administrative-claims-policy';

const principal = (claims: Record<string, unknown>) => ({
  issuer: 'trusted-issuer',
  subject: 'trusted-subject',
  claims,
});

describe('Administrative JWT claims policy', () => {
  const original = { ...process.env };
  beforeEach(() => {
    process.env.OIDC_ROLES_CLAIM = 'roles';
    process.env.OIDC_PERMISSIONS_CLAIM = 'scope';
    process.env.OIDC_OPERATOR_ROLES = 'operator';
    process.env.OIDC_ADMIN_ROLES = 'admin';
    delete process.env.OIDC_QUARANTINE_READ_PERMISSION;
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it('requires exact role and permission matches, rejects malformed claims and never grants a wildcard admin bypass', () => {
    const policy = new AdministrativeClaimsPolicy();
    for (const claims of [
      {},
      { roles: ['provider'], scope: 'quarantine:read' },
      { roles: ['admin'], scope: '*' },
      { roles: ['operator'], scope: 'quarantine:read-extra' },
      { roles: ['admin', 1], scope: 'quarantine:read' },
      { roles: { admin: true }, scope: 'quarantine:read' },
    ])
      expect(() => policy.require(principal(claims), 'quarantine.read')).toThrow();
    expect(() =>
      policy.require(
        principal({ roles: ['operator'], scope: 'quarantine:read' }),
        'quarantine.read',
      ),
    ).not.toThrow();
    expect(() =>
      policy.require(principal({ roles: 'admin', scope: ['quarantine:read'] }), 'quarantine.read'),
    ).not.toThrow();
  });

  it('supports explicitly configured claim names, roles and permission identifiers', () => {
    Object.assign(process.env, {
      OIDC_ROLES_CLAIM: 'realm_roles',
      OIDC_PERMISSIONS_CLAIM: 'permissions',
      OIDC_OPERATOR_ROLES: 'support,auditor',
      OIDC_ADMIN_ROLES: 'security-admin',
      OIDC_QUARANTINE_READ_PERMISSION: 'message:inspect',
    });
    const policy = new AdministrativeClaimsPolicy();
    expect(() =>
      policy.require(
        principal({ realm_roles: ['support'], permissions: ['message:inspect'] }),
        'quarantine.read',
      ),
    ).not.toThrow();
    expect(() =>
      policy.require(principal({ roles: ['admin'], scope: 'quarantine:read' }), 'quarantine.read'),
    ).toThrow();
  });

  it('fails closed for empty or wildcard configuration instead of silently reverting to defaults', () => {
    const policy = new AdministrativeClaimsPolicy();
    for (const value of ['', '*', 'admin,']) {
      process.env.OIDC_ADMIN_ROLES = value;
      expect(() =>
        policy.require(
          principal({ roles: ['admin'], scope: 'quarantine:read' }),
          'quarantine.read',
        ),
      ).toThrow('Service Unavailable');
    }
  });
});

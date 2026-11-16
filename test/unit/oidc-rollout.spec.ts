import { validatePlan, rolloutFiles } from '../../scripts/oidc-rollout';
import example from '../../infra/rollout/plan.example.json';

describe('Rollout preparation boundaries', () => {
  it('renders authenticated API and OAuth2 metrics without inline secrets or TLS bypass', () => {
    const generated = rolloutFiles(validatePlan(example));
    const api = JSON.parse(generated.apiEnvironment);
    const scrape = JSON.parse(generated.prometheus).scrape_configs[0];
    expect(api).toMatchObject({ AUTH_MODE: 'oidc', METRICS_ACCESS: 'authenticated' });
    expect(scrape.oauth2).toMatchObject({
      scopes: ['metrics:read'],
      client_secret_file: example.metricsClientSecretFile,
    });
    expect(scrape.oauth2).not.toHaveProperty('client_secret');
    expect(scrape).not.toHaveProperty('tls_config');
  });
  it('rejects unsafe transports, embedded credentials, secret fields and unapproved action shapes', () => {
    for (const patch of [
      { issuer: 'http://idp.external.test' },
      { tokenUrl: 'https://user:secret@idp.test/token' },
      { clientSecret: 'must-not-be-in-plan' },
      { metricsClientSecretFile: './secret' },
      { operators: [{ subject: 'operator', actions: ['*'] }] },
      { operators: [{ subject: 'operator', actions: ['quarantine.read'], role: 'admin' }] },
    ])
      expect(() => validatePlan({ ...example, ...patch })).toThrow('INVALID_ROLLOUT_PLAN');
  });
  it('rejects duplicate subjects and empty plans instead of inferring authorization', () => {
    expect(() => validatePlan({ ...example, operators: [] })).toThrow();
    expect(() =>
      validatePlan({ ...example, operators: [example.operators[0], example.operators[0]] }),
    ).toThrow();
  });
});

import { createServer, Server } from 'node:http';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { OidcJwtVerifier } from '../../src/interfaces/http/oidc-jwt.verifier';
import { publicOidcAddress, trustedOidcUrl } from '../../src/interfaces/http/oidc-http-client';

describe('OIDC hardening with a real rotating HTTP IdP', () => {
  const original = { ...process.env };
  const keys = [0, 1].map(() => generateKeyPairSync('rsa', { modulusLength: 2048 }));
  let server: Server;
  let issuer: string;
  let generation = 0;
  let kid = 'first';
  let requests = 0;
  let mode = 'valid';
  beforeAll(async () => {
    server = createServer((req, res) => {
      requests++;
      if (mode === 'timeout') return;
      if (mode === 'error') {
        res.writeHead(503);
        res.end();
        return;
      }
      if (mode === 'redirect') {
        res.writeHead(302, { location: 'http://169.254.169.254/' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url?.includes('openid-configuration')) {
        res.end(
          JSON.stringify({
            issuer: mode === 'issuer' ? 'https://evil.test' : issuer,
            jwks_uri: mode === 'cross-origin' ? 'https://evil.test/keys' : `${issuer}/keys`,
          }),
        );
        return;
      }
      const jwk = {
        ...keys[generation]!.publicKey.export({ format: 'jwk' }),
        kid,
        alg: 'RS256',
        use: 'sig',
      };
      res.end(
        JSON.stringify({
          keys:
            mode === 'malformed'
              ? [{ ...jwk, n: 'broken', e: '!' }]
              : mode === 'duplicate'
                ? [jwk, jwk]
                : [jwk],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error();
    issuer = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(() => {
    generation = 0;
    kid = 'first';
    requests = 0;
    mode = 'valid';
    Object.assign(process.env, {
      AUTH_MODE: 'oidc',
      NODE_ENV: 'test',
      OIDC_ALLOW_LOOPBACK_HTTP: 'true',
      OIDC_ISSUER_URL: issuer,
      OIDC_AUDIENCE: 'api',
      OIDC_JWKS_URI: `${issuer}/keys`,
      OIDC_JWKS_REFRESH_COOLDOWN_MS: '10',
      OIDC_HTTP_TIMEOUT_MS: '100',
      OIDC_CLOCK_SKEW_SECONDS: '0',
    });
  });
  afterEach(() => {
    process.env = { ...original };
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  function token(
    claims: Record<string, unknown> = {},
    header: Record<string, unknown> = {},
    signer = generation,
  ) {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode({ alg: 'RS256', kid, ...header })}.${encode({ iss: issuer, aud: 'api', sub: 'subject', providerId: 'provider-a', exp: Math.floor(Date.now() / 1000) + 300, ...claims })}`;
    const signature = createSign('RSA-SHA256');
    signature.update(input);
    return `Bearer ${input}.${signature.sign(keys[signer]!.privateKey).toString('base64url')}`;
  }
  it('rejects invalid signatures, expiration, issuer, audience, malformed structure and algorithms', async () => {
    const verifier = new OidcJwtVerifier();
    for (const [value, code] of [
      [token({}, {}, 1), 'INVALID_TOKEN_SIGNATURE'],
      [token({ exp: Math.floor(Date.now() / 1000) - 1 }), 'TOKEN_EXPIRED'],
      [token({ aud: 'other' }), 'INVALID_TOKEN_AUDIENCE'],
      [token({ iss: 'https://other.test' }), 'INVALID_TOKEN_ISSUER'],
      [token({ exp: Number.MAX_VALUE }), 'TOKEN_EXPIRED'],
      [token({ aud: ['api', 1] }), 'INVALID_TOKEN_AUDIENCE'],
      [token({}, { alg: 'none' }), 'UNSUPPORTED_TOKEN_ALGORITHM'],
      [token({}, { crit: ['custom'] }), 'UNSUPPORTED_TOKEN_ALGORITHM'],
      [token() + '.extra', 'INVALID_TOKEN'],
    ])
      await expect(verifier.verify(value)).rejects.toMatchObject({ message: code });
  });
  it('rotates new and reused kids, evicts removed keys and coalesces parallel refreshes', async () => {
    const verifier = new OidcJwtVerifier();
    const valid = token();
    await Promise.all(Array.from({ length: 12 }, () => verifier.verify(valid)));
    expect(requests).toBe(1);
    const old = token();
    generation = 1;
    kid = 'second';
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(verifier.verify(token())).resolves.toMatchObject({ providerId: 'provider-a' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(verifier.verify(old)).rejects.toMatchObject({ message: 'UNKNOWN_TOKEN_KEY' });
    generation = 0;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(verifier.verify(token())).resolves.toMatchObject({ subject: 'subject' });
    expect(requests).toBe(4);
    process.env.OIDC_AUDIENCE = 'changed-api';
    await expect(verifier.verify(token({ aud: 'changed-api' }))).rejects.toMatchObject({
      message: 'OIDC_CONFIGURATION_INVALID',
    });
  });
  it('rejects discovery issuer mismatch, cross-origin JWKS, redirects and malformed keys', async () => {
    for (const failure of ['issuer', 'cross-origin', 'redirect', 'malformed', 'duplicate']) {
      mode = failure;
      delete process.env.OIDC_JWKS_URI;
      await expect(new OidcJwtVerifier().verify(token())).rejects.toMatchObject({
        message: 'OIDC_KEYS_UNAVAILABLE',
        retryable: true,
      });
    }
  });
  it('bounds IdP timeout and unavailability without exposing server response data', async () => {
    for (const failure of ['timeout', 'error']) {
      mode = failure;
      const started = Date.now();
      await expect(new OidcJwtVerifier().verify(token())).rejects.toMatchObject({
        message: 'OIDC_KEYS_UNAVAILABLE',
        retryable: true,
      });
      expect(Date.now() - started).toBeLessThan(1500);
    }
  });
  it('fails configuration at startup and never enables the loopback exception in production', () => {
    const verifier = new OidcJwtVerifier();
    delete process.env.OIDC_AUDIENCE;
    expect(() => verifier.onModuleInit()).toThrow('OIDC_CONFIGURATION_INVALID');
    process.env.OIDC_AUDIENCE = 'api';
    process.env.NODE_ENV = 'production';
    expect(() => verifier.onModuleInit()).toThrow('OIDC_CONFIGURATION_INVALID');
    process.env.AUTH_MODE = 'challenge';
    delete process.env.METRICS_ACCESS;
    expect(() => verifier.onModuleInit()).not.toThrow();
  });
  it('blocks private, metadata, mapped IPv6, non-HTTPS and credential-bearing URLs', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '169.254.169.254',
      '100.100.100.200',
      '192.168.1.1',
      '::1',
      '::ffff:127.0.0.1',
      'fc00::1',
      'fe80::1',
      '2002:7f00:1::',
    ])
      expect(publicOidcAddress(address)).toBe(false);
    for (const url of [
      'http://public.test/keys',
      'https://user:pass@public.test/keys',
      'https://169.254.169.254/keys',
      'https://[::ffff:127.0.0.1]/keys',
    ])
      expect(() => trustedOidcUrl(url, false)).toThrow();
  });
});

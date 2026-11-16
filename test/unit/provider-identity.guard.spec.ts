import { ExecutionContext } from '@nestjs/common';
import { generateKeyPairSync, createSign } from 'node:crypto';
import {
  ChallengeProviderIdentityGuard,
  AuthenticatedRequest,
} from '../../src/interfaces/http/provider-identity.guard';
import { OidcJwtVerifier } from '../../src/interfaces/http/oidc-jwt.verifier';

function context(request: AuthenticatedRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

describe('ChallengeProviderIdentityGuard', () => {
  const originalEnv = { ...process.env };
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: 'jwk' }) as { kty: string; n: string; e: string };
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
  });

  function token(claims: Record<string, unknown>): string {
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'key-1' }));
    const payload = base64url(JSON.stringify(claims));
    const input = `${header}.${payload}`;
    const signer = createSign('RSA-SHA256');
    signer.update(input);
    signer.end();
    return `${input}.${signer.sign(privateKey).toString('base64url')}`;
  }

  function configure() {
    process.env.AUTH_MODE = 'oidc';
    process.env.OIDC_ISSUER_URL = 'https://issuer.example.test';
    process.env.OIDC_AUDIENCE = 'jungle-api';
    process.env.OIDC_JWKS_URI = 'https://issuer.example.test/keys';
    process.env.OIDC_PROVIDER_ID_CLAIM = 'providerId';
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: 'key-1', use: 'sig' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
  }

  it('keeps challenge mode explicit and permissive when OIDC is disabled', async () => {
    delete process.env.AUTH_MODE;
    const guard = new ChallengeProviderIdentityGuard();
    await expect(guard.canActivate(context({ headers: {} }))).resolves.toBe(true);
  });

  it('accepts a valid RS256 token and binds its provider identity to the request', async () => {
    configure();
    const guard = new ChallengeProviderIdentityGuard(new OidcJwtVerifier());
    const request: AuthenticatedRequest = {
      headers: {
        authorization: `Bearer ${token({
          iss: process.env.OIDC_ISSUER_URL,
          aud: 'jungle-api',
          sub: 'subject-1',
          providerId: 'provider-a',
          exp: Math.floor(Date.now() / 1_000) + 300,
        })}`,
      },
      body: { providerId: 'provider-a' },
    };

    await expect(guard.canActivate(context(request))).resolves.toBe(true);
    expect(request.principal).toMatchObject({ subject: 'subject-1', providerId: 'provider-a' });
  });

  it('rejects missing, expired and unsupported tokens', async () => {
    configure();
    const guard = new ChallengeProviderIdentityGuard(new OidcJwtVerifier());
    await expect(guard.canActivate(context({ headers: {} }))).rejects.toMatchObject({
      response: { errorCode: 'AUTHORIZATION_REQUIRED' },
    });
    await expect(
      guard.canActivate(
        context({
          headers: {
            authorization: `Bearer ${token({
              iss: process.env.OIDC_ISSUER_URL,
              aud: 'jungle-api',
              sub: 'subject-1',
              providerId: 'provider-a',
              exp: Math.floor(Date.now() / 1_000) - 600,
            })}`,
          },
        }),
      ),
    ).rejects.toMatchObject({ response: { errorCode: 'TOKEN_EXPIRED' } });
  });

  it('rejects a body provider different from the authenticated provider', async () => {
    configure();
    const guard = new ChallengeProviderIdentityGuard(new OidcJwtVerifier());
    const request: AuthenticatedRequest = {
      headers: {
        authorization: `Bearer ${token({
          iss: process.env.OIDC_ISSUER_URL,
          aud: 'jungle-api',
          sub: 'subject-1',
          providerId: 'provider-a',
          exp: Math.floor(Date.now() / 1_000) + 300,
        })}`,
      },
      body: { providerId: 'provider-b' },
    };

    await expect(guard.canActivate(context(request))).rejects.toMatchObject({
      response: { errorCode: 'PROVIDER_IDENTITY_MISMATCH' },
    });
  });
});

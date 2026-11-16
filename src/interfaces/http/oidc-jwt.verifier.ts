import { createPublicKey, verify as verifySignature } from 'node:crypto';
import type { JsonWebKey as NodeJsonWebKey } from 'node:crypto';

export interface AuthenticatedProviderPrincipal {
  subject: string;
  providerId: string;
  issuer: string;
  claims: Record<string, unknown>;
}

interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

interface Jwk {
  kty: string;
  kid?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
}

interface JwksResponse {
  keys?: Jwk[];
}

export class OidcJwtError extends Error {
  constructor(
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'OidcJwtError';
  }
}

export class OidcJwtVerifier {
  private readonly cache = new Map<
    string,
    { key: ReturnType<typeof createPublicKey>; expiresAt: number }
  >();
  private discovery?: { jwksUri: string; expiresAt: number };
  private readonly cacheTtlMs =
    this.readPositiveInteger(process.env.OIDC_JWKS_CACHE_TTL_SECONDS, 300) * 1_000;
  private readonly timeoutMs = this.readPositiveInteger(process.env.OIDC_HTTP_TIMEOUT_MS, 3_000);

  async verify(authorization: string | undefined): Promise<AuthenticatedProviderPrincipal> {
    const token = this.readBearerToken(authorization);
    const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');
    if (!encodedHeader || !encodedPayload || !encodedSignature)
      throw new OidcJwtError('INVALID_TOKEN');

    const header = this.decodeJson<JwtHeader>(encodedHeader, 'INVALID_TOKEN');
    const claims = this.decodeJson<Record<string, unknown>>(encodedPayload, 'INVALID_TOKEN');
    if (header.alg !== 'RS256' || !header.kid)
      throw new OidcJwtError('UNSUPPORTED_TOKEN_ALGORITHM');

    const issuer = this.requiredString(process.env.OIDC_ISSUER_URL, 'OIDC_NOT_CONFIGURED').replace(
      /\/$/,
      '',
    );
    if (claims.iss !== issuer) throw new OidcJwtError('INVALID_TOKEN_ISSUER');
    this.validateAudience(claims.aud);
    this.validateTimeClaims(claims);

    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signature = this.decodeBase64Url(encodedSignature, 'INVALID_TOKEN');
    let key = this.cache.get(header.kid);
    if (!key || key.expiresAt <= Date.now()) {
      await this.refreshKeys();
      key = this.cache.get(header.kid);
    }
    if (!key) throw new OidcJwtError('UNKNOWN_TOKEN_KEY');

    if (!verifySignature('RSA-SHA256', Buffer.from(signingInput), key.key, signature)) {
      throw new OidcJwtError('INVALID_TOKEN_SIGNATURE');
    }

    const subject = this.requiredString(claims.sub, 'INVALID_TOKEN_SUBJECT');
    const providerClaim = process.env.OIDC_PROVIDER_ID_CLAIM ?? 'providerId';
    const providerId = this.requiredString(claims[providerClaim], 'TOKEN_PROVIDER_MISSING');
    return { subject, providerId, issuer, claims };
  }

  private async refreshKeys(): Promise<void> {
    const jwksUri = await this.resolveJwksUri();
    let response: Response;
    try {
      response = await fetch(jwksUri, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw new OidcJwtError('OIDC_PROVIDER_UNAVAILABLE', true);
    }
    if (!response.ok) throw new OidcJwtError('OIDC_JWKS_UNAVAILABLE', true);
    let body: JwksResponse;
    try {
      body = (await response.json()) as JwksResponse;
    } catch {
      throw new OidcJwtError('INVALID_OIDC_JWKS', true);
    }
    if (!Array.isArray(body.keys)) throw new OidcJwtError('INVALID_OIDC_JWKS', true);

    const expiresAt = Date.now() + this.cacheTtlMs;
    for (const jwk of body.keys) {
      if (jwk.kty !== 'RSA' || !jwk.kid || !jwk.n || !jwk.e || (jwk.use && jwk.use !== 'sig'))
        continue;
      try {
        this.cache.set(jwk.kid, {
          key: createPublicKey({ key: jwk as NodeJsonWebKey, format: 'jwk' }),
          expiresAt,
        });
      } catch {
        // Ignore malformed keys; a token using one will fail closed.
      }
    }
    if (this.cache.size === 0) throw new OidcJwtError('INVALID_OIDC_JWKS', true);
  }

  private async resolveJwksUri(): Promise<string> {
    const configured = process.env.OIDC_JWKS_URI;
    if (configured) return configured;
    if (this.discovery && this.discovery.expiresAt > Date.now()) return this.discovery.jwksUri;
    const issuer = this.requiredString(process.env.OIDC_ISSUER_URL, 'OIDC_NOT_CONFIGURED').replace(
      /\/$/,
      '',
    );
    let response: Response;
    try {
      response = await fetch(`${issuer}/.well-known/openid-configuration`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new OidcJwtError('OIDC_PROVIDER_UNAVAILABLE', true);
    }
    if (!response.ok) throw new OidcJwtError('OIDC_DISCOVERY_UNAVAILABLE', true);
    const body = (await response.json()) as { jwks_uri?: unknown };
    if (typeof body.jwks_uri !== 'string' || !body.jwks_uri) {
      throw new OidcJwtError('INVALID_OIDC_DISCOVERY', true);
    }
    this.discovery = { jwksUri: body.jwks_uri, expiresAt: Date.now() + this.cacheTtlMs };
    return body.jwks_uri;
  }

  private validateAudience(audience: unknown): void {
    const expected = process.env.OIDC_AUDIENCE;
    if (!expected) throw new OidcJwtError('OIDC_NOT_CONFIGURED');
    const values = Array.isArray(audience) ? audience : [audience];
    if (!values.includes(expected)) throw new OidcJwtError('INVALID_TOKEN_AUDIENCE');
  }

  private validateTimeClaims(claims: Record<string, unknown>): void {
    const now = Math.floor(Date.now() / 1_000);
    const clockSkew = this.readPositiveInteger(process.env.OIDC_CLOCK_SKEW_SECONDS, 30);
    if (typeof claims.exp !== 'number' || claims.exp + clockSkew < now) {
      throw new OidcJwtError('TOKEN_EXPIRED');
    }
    if (
      claims.nbf !== undefined &&
      (typeof claims.nbf !== 'number' || claims.nbf - clockSkew > now)
    ) {
      throw new OidcJwtError('TOKEN_NOT_ACTIVE');
    }
  }

  private readBearerToken(authorization: string | undefined): string {
    const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
    if (!match?.[1]) throw new OidcJwtError('AUTHORIZATION_REQUIRED');
    return match[1];
  }

  private decodeJson<T>(value: string, errorCode: string): T {
    try {
      return JSON.parse(this.decodeBase64Url(value, errorCode).toString('utf8')) as T;
    } catch {
      throw new OidcJwtError(errorCode);
    }
  }

  private decodeBase64Url(value: string, errorCode: string): Buffer {
    try {
      const decoded = Buffer.from(value, 'base64url');
      if (!decoded.length) throw new Error(errorCode);
      return decoded;
    } catch {
      throw new OidcJwtError(errorCode);
    }
  }

  private requiredString(value: unknown, errorCode: string): string {
    if (typeof value !== 'string' || !value) throw new OidcJwtError(errorCode);
    return value;
  }

  private readPositiveInteger(value: string | undefined, fallback: number): number {
    const parsed = value === undefined ? fallback : Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 1) return fallback;
    return parsed;
  }
}

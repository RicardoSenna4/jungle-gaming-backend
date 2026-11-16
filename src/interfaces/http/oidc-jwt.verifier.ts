import { Injectable, OnModuleInit } from '@nestjs/common';
import { createPublicKey, verify as verifySignature } from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';
import { oidcJson, trustedOidcUrl } from './oidc-http-client';

export interface AuthenticatedProviderPrincipal {
  subject: string;
  providerId?: string;
  issuer: string;
  claims: Record<string, unknown>;
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
interface Configuration {
  issuer: string;
  audience: string;
  jwks?: string;
  origins: string[];
  loopback: boolean;
  ttl: number;
  timeout: number;
  cooldown: number;
  skew: number;
  providerClaim: string;
}
type CachedKey = { key: ReturnType<typeof createPublicKey>; expiresAt: number };

@Injectable()
export class OidcJwtVerifier implements OnModuleInit {
  private cache = new Map<string, CachedKey>();
  private discovery?: { jwksUri: string; expiresAt: number };
  private fingerprint = '';
  private refreshing?: Promise<void>;
  private lastRefresh = 0;

  onModuleInit(): void {
    const mode = (process.env.AUTH_MODE ?? 'challenge').toLowerCase();
    if (!['challenge', 'oidc'].includes(mode)) throw new OidcJwtError('AUTH_MODE_INVALID', true);
    if (mode === 'oidc' || process.env.METRICS_ACCESS === 'authenticated') this.configuration();
  }

  private configuration(): Configuration {
    try {
      const issuer = this.requiredString(process.env.OIDC_ISSUER_URL, 'OIDC_NOT_CONFIGURED');
      const audience = this.requiredString(process.env.OIDC_AUDIENCE, 'OIDC_NOT_CONFIGURED');
      const loopback =
        process.env.OIDC_ALLOW_LOOPBACK_HTTP === 'true' &&
        ['test', 'development'].includes(process.env.NODE_ENV ?? '');
      const issuerUrl = trustedOidcUrl(issuer, loopback);
      const jwks = process.env.OIDC_JWKS_URI?.trim() || undefined;
      if (jwks !== undefined) trustedOidcUrl(jwks, loopback);
      const origins = (process.env.OIDC_JWKS_ALLOWED_ORIGINS ?? '')
        .split(',')
        .filter(Boolean)
        .map((value) => {
          const url = trustedOidcUrl(value.trim(), loopback);
          if (url.pathname !== '/') throw new Error();
          return url.origin;
        });
      const result = {
        issuer,
        audience,
        jwks,
        origins: [issuerUrl.origin, ...origins],
        loopback,
        ttl: this.number('OIDC_JWKS_CACHE_TTL_SECONDS', 300, 1, 3600) * 1000,
        timeout: this.number('OIDC_HTTP_TIMEOUT_MS', 3000, 50, 30000),
        cooldown: this.number('OIDC_JWKS_REFRESH_COOLDOWN_MS', 1000, 10, 60000),
        skew: this.number('OIDC_CLOCK_SKEW_SECONDS', 30, 0, 300),
        providerClaim: this.requiredString(
          process.env.OIDC_PROVIDER_ID_CLAIM ?? 'providerId',
          'OIDC_NOT_CONFIGURED',
        ),
      };
      const fingerprint = JSON.stringify(result);
      if (this.fingerprint && fingerprint !== this.fingerprint)
        throw new Error('OIDC_CONFIGURATION_CHANGED');
      if (fingerprint !== this.fingerprint) {
        this.cache.clear();
        this.discovery = undefined;
        this.lastRefresh = 0;
        this.fingerprint = fingerprint;
      }
      return result;
    } catch {
      throw new OidcJwtError('OIDC_CONFIGURATION_INVALID', true);
    }
  }

  async verify(
    authorization: string | undefined,
    requireProvider = true,
  ): Promise<AuthenticatedProviderPrincipal> {
    const config = this.configuration();
    const token = this.readBearerToken(authorization);
    const parts = token.split('.');
    if (parts.length !== 3) throw new OidcJwtError('INVALID_TOKEN');
    const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
    const header = this.decodeJson(encodedHeader);
    const claims = this.decodeJson(encodedPayload);
    if (
      header.alg !== 'RS256' ||
      typeof header.kid !== 'string' ||
      !header.kid.trim() ||
      header.kid.length > 128 ||
      header.crit !== undefined ||
      header.b64 !== undefined ||
      (header.typ !== undefined && header.typ !== 'JWT' && header.typ !== 'at+jwt')
    )
      throw new OidcJwtError('UNSUPPORTED_TOKEN_ALGORITHM');
    if (claims.iss !== config.issuer) throw new OidcJwtError('INVALID_TOKEN_ISSUER');
    this.validateAudience(claims.aud, config.audience);
    this.validateTimeClaims(claims, config.skew);
    const subject = this.requiredString(claims.sub, 'INVALID_TOKEN_SUBJECT');
    const providerId = requireProvider
      ? this.requiredString(claims[config.providerClaim], 'TOKEN_PROVIDER_MISSING')
      : undefined;
    const signature = this.decodeBase64Url(encodedSignature);
    const signingInput = Buffer.from(`${encodedHeader}.${encodedPayload}`);
    let cached = this.cache.get(header.kid);
    if (!cached || cached.expiresAt <= Date.now()) {
      await this.refreshKeys(config, !cached);
      cached = this.cache.get(header.kid);
    }
    if (!cached || cached.expiresAt <= Date.now()) throw new OidcJwtError('UNKNOWN_TOKEN_KEY');
    if (!verifySignature('RSA-SHA256', signingInput, cached.key, signature)) {
      // Supports same-kid rotation without allowing a refresh for every forged signature.
      if (Date.now() - this.lastRefresh >= config.cooldown) {
        await this.refreshKeys(config, false);
        cached = this.cache.get(header.kid);
      }
      if (
        !cached ||
        cached.expiresAt <= Date.now() ||
        !verifySignature('RSA-SHA256', signingInput, cached.key, signature)
      )
        throw new OidcJwtError('INVALID_TOKEN_SIGNATURE');
    }
    return { subject, providerId, issuer: config.issuer, claims };
  }

  private async refreshKeys(config: Configuration, unknownKid: boolean): Promise<void> {
    if (this.refreshing) return this.refreshing;
    if (Date.now() - this.lastRefresh < config.cooldown)
      throw new OidcJwtError(
        unknownKid ? 'UNKNOWN_TOKEN_KEY' : 'OIDC_REFRESH_THROTTLED',
        !unknownKid,
      );
    this.lastRefresh = Date.now();
    this.refreshing = (async () => {
      try {
        const uri = await this.resolveJwksUri(config);
        const body = await oidcJson(
          trustedOidcUrl(uri, config.loopback),
          config.timeout,
          config.loopback,
        );
        if (!Array.isArray(body.keys) || !body.keys.length || body.keys.length > 32)
          throw new Error();
        const next = new Map<string, CachedKey>();
        for (const value of body.keys) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
          const jwk = value as Record<string, unknown>;
          if (
            jwk.kty !== 'RSA' ||
            (jwk.use !== undefined && jwk.use !== 'sig') ||
            (jwk.alg !== undefined && jwk.alg !== 'RS256')
          )
            continue;
          if (
            typeof jwk.kid !== 'string' ||
            !jwk.kid.trim() ||
            jwk.kid.length > 128 ||
            next.has(jwk.kid) ||
            typeof jwk.n !== 'string' ||
            typeof jwk.e !== 'string' ||
            ['d', 'p', 'q', 'dp', 'dq', 'qi'].some((field) => jwk[field] !== undefined) ||
            (jwk.key_ops !== undefined &&
              (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes('verify')))
          )
            throw new Error();
          this.decodeBase64Url(jwk.n);
          this.decodeBase64Url(jwk.e);
          const key = createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' });
          if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error();
          next.set(jwk.kid, { key, expiresAt: Date.now() + config.ttl });
        }
        if (!next.size) throw new Error();
        this.cache = next; // Removed keys disappear; old snapshots never accumulate.
      } catch {
        throw new OidcJwtError('OIDC_KEYS_UNAVAILABLE', true);
      }
    })();
    try {
      await this.refreshing;
    } finally {
      this.refreshing = undefined;
    }
  }

  private async resolveJwksUri(config: Configuration): Promise<string> {
    if (config.jwks) return config.jwks;
    if (this.discovery && this.discovery.expiresAt > Date.now()) return this.discovery.jwksUri;
    const body = await oidcJson(
      trustedOidcUrl(
        `${config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
        config.loopback,
      ),
      config.timeout,
      config.loopback,
    );
    if (body.issuer !== config.issuer || typeof body.jwks_uri !== 'string') throw new Error();
    const url = trustedOidcUrl(body.jwks_uri, config.loopback);
    if (!config.origins.includes(url.origin)) throw new Error();
    this.discovery = { jwksUri: url.toString(), expiresAt: Date.now() + config.ttl };
    return url.toString();
  }
  private validateAudience(audience: unknown, expected: string): void {
    const values = Array.isArray(audience) ? audience : [audience];
    if (
      !values.length ||
      values.length > 32 ||
      !values.every((value) => typeof value === 'string' && value.trim()) ||
      !values.includes(expected)
    )
      throw new OidcJwtError('INVALID_TOKEN_AUDIENCE');
  }
  private validateTimeClaims(claims: Record<string, unknown>, skew: number): void {
    const now = Math.floor(Date.now() / 1000);
    if (
      !Number.isSafeInteger(claims.exp) ||
      Number(claims.exp) < 0 ||
      Number(claims.exp) + skew <= now
    )
      throw new OidcJwtError('TOKEN_EXPIRED');
    for (const field of ['nbf', 'iat'])
      if (
        claims[field] !== undefined &&
        (!Number.isSafeInteger(claims[field]) ||
          Number(claims[field]) < 0 ||
          Number(claims[field]) - skew > now)
      )
        throw new OidcJwtError('TOKEN_NOT_ACTIVE');
  }
  private readBearerToken(authorization: string | undefined): string {
    const match = authorization?.match(/^Bearer\s+([A-Za-z0-9_.-]+)$/i);
    if (!match?.[1]) throw new OidcJwtError('AUTHORIZATION_REQUIRED');
    if (match[1].length > 16384) throw new OidcJwtError('INVALID_TOKEN');
    return match[1];
  }
  private decodeJson(value: string): Record<string, unknown> {
    try {
      const decoded: unknown = JSON.parse(this.decodeBase64Url(value).toString('utf8'));
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error();
      return decoded as Record<string, unknown>;
    } catch {
      throw new OidcJwtError('INVALID_TOKEN');
    }
  }
  private decodeBase64Url(value: string): Buffer {
    if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new OidcJwtError('INVALID_TOKEN');
    const bytes = Buffer.from(value, 'base64url');
    if (!bytes.length || bytes.toString('base64url') !== value)
      throw new OidcJwtError('INVALID_TOKEN');
    return bytes;
  }
  private requiredString(value: unknown, code: string): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 2048)
      throw new OidcJwtError(code);
    return value;
  }
  private number(name: string, fallback: number, min: number, max: number): number {
    const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error();
    return value;
  }
}

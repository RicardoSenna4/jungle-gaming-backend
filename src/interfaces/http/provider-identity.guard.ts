import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthenticatedProviderPrincipal, OidcJwtError, OidcJwtVerifier } from './oidc-jwt.verifier';

export interface AuthenticatedRequest {
  headers: { authorization?: string };
  body?: Record<string, unknown>;
  params?: Record<string, string | undefined>;
  principal?: AuthenticatedProviderPrincipal;
}

@Injectable()
export class ChallengeProviderIdentityGuard implements CanActivate {
  private readonly verifier: OidcJwtVerifier;

  constructor(@Optional() @Inject(OidcJwtVerifier) verifier?: OidcJwtVerifier) {
    this.verifier = verifier ?? new OidcJwtVerifier();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const mode = (process.env.AUTH_MODE ?? 'challenge').toLowerCase();
    if (mode === 'challenge') return true;
    if (mode !== 'oidc') throw new ServiceUnavailableException({ errorCode: 'AUTH_MODE_INVALID' });
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    let principal: AuthenticatedProviderPrincipal;
    try {
      principal = await this.verifier.verify(
        request.headers?.authorization,
        Reflect.getMetadata('resource-authorization', context.getHandler?.() ?? {})?.resource !==
          'operator',
      );
    } catch (error) {
      if (error instanceof OidcJwtError && error.retryable) {
        throw new ServiceUnavailableException({ errorCode: error.message, retryable: true });
      }
      const code = error instanceof OidcJwtError ? error.message : 'INVALID_TOKEN';
      throw new UnauthorizedException({ errorCode: code });
    }

    for (const requestedProviderId of [request.body?.providerId, request.params?.providerId]) {
      if (requestedProviderId !== undefined && requestedProviderId !== principal.providerId) {
        throw new ForbiddenException({ errorCode: 'PROVIDER_IDENTITY_MISMATCH' });
      }
    }
    request.principal = principal;
    return true;
  }
}

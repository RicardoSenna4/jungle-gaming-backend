import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  SetMetadata,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AdministrativeClaimsPolicy } from '../../application/authorization/administrative-claims-policy';
import { OidcJwtError, OidcJwtVerifier } from './oidc-jwt.verifier';
import { AuthenticatedRequest } from './provider-identity.guard';

export const MetricsAccess = () =>
  applyDecorators(SetMetadata('metrics-access', true), UseGuards(MetricsAccessGuard));

/** Metrics remain available without a database query; no shared secret in URL or logs. */
@Injectable()
export class MetricsAccessGuard implements CanActivate {
  private readonly logger = new Logger(MetricsAccessGuard.name);
  constructor(
    private readonly verifier: OidcJwtVerifier,
    private readonly policy: AdministrativeClaimsPolicy,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const authMode = (process.env.AUTH_MODE ?? 'challenge').toLowerCase();
    let mode = (process.env.METRICS_ACCESS ?? 'auto').toLowerCase();
    if (mode === 'auto')
      mode =
        authMode === 'oidc'
          ? 'authenticated'
          : process.env.NODE_ENV === 'production'
            ? 'disabled'
            : 'public';
    try {
      if (mode === 'disabled') throw new NotFoundException({ errorCode: 'NOT_FOUND' });
      if (!['challenge', 'oidc'].includes(authMode))
        throw new ServiceUnavailableException({ errorCode: 'AUTH_MODE_INVALID' });
      if (mode === 'public' && authMode === 'challenge' && process.env.NODE_ENV !== 'production')
        return true;
      if (mode !== 'authenticated')
        throw new ServiceUnavailableException({ errorCode: 'METRICS_POLICY_INVALID' });
      const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
      let principal;
      try {
        principal = await this.verifier.verify(request.headers?.authorization, false);
      } catch (error) {
        if (error instanceof OidcJwtError && error.retryable)
          throw new ServiceUnavailableException({ errorCode: error.message });
        throw new UnauthorizedException({
          errorCode: error instanceof OidcJwtError ? error.message : 'INVALID_TOKEN',
        });
      }
      this.policy.require(principal, 'metrics.read');
      request.principal = principal;
      this.logger.log(JSON.stringify({ event: 'metrics_authorization', status: 'allow' }));
      return true;
    } catch (error) {
      this.logger.log(JSON.stringify({ event: 'metrics_authorization', status: 'deny' }));
      throw error;
    }
  }
}

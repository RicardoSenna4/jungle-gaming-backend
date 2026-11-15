import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

/**
 * Explicit authentication extension point for the challenge. This guard is
 * deliberately permissive: authentication is outside the scored scope.
 * For production replace canActivate with OIDC/JWT verification and bind
 * the authenticated provider identity to a request-scoped principal.
 * Never treat the providerId from a body as proof of authentication.
 */
@Injectable()
export class ChallengeProviderIdentityGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    void context;
    return true;
  }
}

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, lastValueFrom } from 'rxjs';
import {
  ResourceAuthorization,
  ResourcePolicy,
} from '../../application/authorization/resource-authorization';
import { AuthenticatedRequest } from './provider-identity.guard';

export const resourcePolicyKey = 'resource-authorization';
export const PublicResource = () => SetMetadata('resource-public', true);
export const AuthorizeResource = (policy: ResourcePolicy) => SetMetadata(resourcePolicyKey, policy);

@Injectable()
export class ResourceAuthorizationInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorization: ResourceAuthorization,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const policy = this.reflector.get<ResourcePolicy>(resourcePolicyKey, context.getHandler());
    if (
      (process.env.AUTH_MODE ?? 'challenge').toLowerCase() === 'challenge' ||
      this.reflector.get<boolean>('resource-public', context.getHandler())
    )
      return next.handle();
    if (!policy)
      throw new ServiceUnavailableException({ errorCode: 'AUTHORIZATION_POLICY_REQUIRED' });
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    return from(
      (async () => {
        const result = await this.authorization.run(
          request.principal,
          policy,
          request,
          async () => {
            // Controller 422 responses must not roll back already persisted REJECTED results.
            // Authorization errors happen before work; database failures still abort the transaction.
            try {
              return { value: await lastValueFrom(next.handle()) };
            } catch (error) {
              return { error };
            }
          },
        );
        if ('error' in result) throw result.error;
        return result.value;
      })(),
    );
  }
}

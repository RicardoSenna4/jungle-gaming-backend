import { ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { AuthenticatedProviderPrincipal } from '../../interfaces/http/oidc-jwt.verifier';

export type AdministrativeAction =
  'quarantine.read' | 'quarantine.resolve' | 'quarantine.redrive' | 'metrics.read';
const permissions = {
  'quarantine.read': ['OIDC_QUARANTINE_READ_PERMISSION', 'quarantine:read'],
  'quarantine.redrive': ['OIDC_QUARANTINE_REDRIVE_PERMISSION', 'quarantine:redrive'],
  'quarantine.resolve': ['OIDC_QUARANTINE_RESOLVE_PERMISSION', 'quarantine:resolve'],
  'metrics.read': ['OIDC_METRICS_READ_PERMISSION', 'metrics:read'],
} as const;

/** Consumes only claims from a cryptographically verified principal, never request DTOs. */
@Injectable()
export class AdministrativeClaimsPolicy {
  require(principal: AuthenticatedProviderPrincipal, action: AdministrativeAction): void {
    const rolesClaim = this.setting('OIDC_ROLES_CLAIM', 'roles');
    const permissionsClaim = this.setting('OIDC_PERMISSIONS_CLAIM', 'scope');
    const operatorRoles = this.roles('OIDC_OPERATOR_ROLES', 'operator');
    const adminRoles = this.roles('OIDC_ADMIN_ROLES', 'admin');
    const [name, fallback] = permissions[action];
    const required = this.setting(name, fallback);
    if (/\s/.test(required) || required === '*') this.invalid();
    const roles = this.values(this.claim(principal.claims, rolesClaim));
    if (![...operatorRoles, ...adminRoles].some((role) => roles.includes(role))) {
      throw new ForbiddenException({ errorCode: 'ADMINISTRATIVE_ROLE_REQUIRED' });
    }
    if (!this.values(this.claim(principal.claims, permissionsClaim)).includes(required)) {
      throw new ForbiddenException({ errorCode: 'ADMINISTRATIVE_PERMISSION_REQUIRED' });
    }
  }

  private claim(claims: Record<string, unknown>, name: string): unknown {
    return Object.prototype.hasOwnProperty.call(claims, name) ? claims[name] : undefined;
  }
  private values(value: unknown): string[] {
    if (typeof value === 'string') return value.split(/\s+/).filter(Boolean);
    if (
      Array.isArray(value) &&
      value.every((item) => typeof item === 'string' && item.length > 0 && !/\s/.test(item))
    )
      return value;
    return [];
  }
  private setting(name: string, fallback: string): string {
    const value = (process.env[name] ?? fallback).trim();
    if (!value || ['__proto__', 'prototype', 'constructor'].includes(value)) this.invalid();
    return value;
  }
  private roles(name: string, fallback: string): string[] {
    const roles = this.setting(name, fallback)
      .split(',')
      .map((role) => role.trim());
    if (roles.some((role) => !role || role === '*' || /\s/.test(role))) this.invalid();
    return roles;
  }
  private invalid(): never {
    throw new ServiceUnavailableException({ errorCode: 'ADMINISTRATIVE_POLICY_INVALID' });
  }
}

import {
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { EntityManager, RequestContext } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedProviderPrincipal } from '../../interfaces/http/oidc-jwt.verifier';
import type {
  OperatorCapability,
  WalletCapability,
} from '../../infrastructure/database/mikro-orm/authorization.entities';

export type ResourcePolicy =
  | { resource: 'wallet'; capability: WalletCapability; parameter?: 'body' }
  | { resource: 'transaction'; external?: boolean }
  | { resource: 'player' }
  | { resource: 'operator'; capability: OperatorCapability };
export interface ResourceRequest {
  body?: Record<string, unknown>;
  params?: Record<string, string | undefined>;
}

@Injectable()
export class ResourceAuthorization {
  constructor(private readonly em: EntityManager) {}

  async run<T>(
    principal: AuthenticatedProviderPrincipal | undefined,
    policy: ResourcePolicy,
    request: ResourceRequest,
    work: () => Promise<T>,
  ): Promise<T> {
    if (!principal) throw new UnauthorizedException({ errorCode: 'AUTHORIZATION_REQUIRED' });
    const correlationId = randomUUID();
    const action =
      policy.resource === 'wallet' || policy.resource === 'operator'
        ? policy.capability
        : policy.resource;
    // Resource identifiers only; never audit request payloads, tokens, notes or Money.
    const candidate =
      request.params?.walletId ??
      request.params?.transactionId ??
      request.params?.externalTransactionId ??
      request.params?.messageId ??
      request.body?.walletId ??
      request.body?.playerId;
    const resource = JSON.stringify({
      type: policy.resource,
      id: typeof candidate === 'string' ? candidate.slice(0, 256) : 'global-or-invalid',
      ...(request.params?.consumerName
        ? { consumer: request.params.consumerName.slice(0, 128) }
        : {}),
    });
    try {
      return await this.em.transactional(async (tx) => {
        await this.authorize(tx, principal, policy, request);
        await this.audit(tx, principal, action, resource, 'allow', correlationId);
        // All HTTP service calls, including nested financial transactions, share these locks.
        return RequestContext.create(tx, work);
      });
    } catch (error) {
      if (error instanceof HttpException) {
        if (error.getStatus() === 403 || error.getStatus() === 404) {
          try {
            await this.audit(this.em.fork(), principal, action, resource, 'deny', correlationId);
          } catch {
            throw new ServiceUnavailableException({ errorCode: 'AUTHORIZATION_UNAVAILABLE' });
          }
        }
        throw error;
      }
      throw new ServiceUnavailableException({ errorCode: 'AUTHORIZATION_UNAVAILABLE' });
    }
  }

  private async audit(
    em: EntityManager,
    principal: AuthenticatedProviderPrincipal,
    action: string,
    resource: string,
    decision: string,
    correlationId: string,
  ) {
    await em.execute(
      `insert into authorization_audit (id, actor_issuer, actor_subject, provider_id, action, resource, decision, source, correlation_id)
      values (?, ?, ?, ?, ?, ?, ?, 'http', ?)`,
      [
        randomUUID(),
        principal.issuer,
        principal.subject,
        principal.providerId ?? null,
        action,
        resource,
        decision,
        correlationId,
      ],
    );
  }

  private async authorize(
    tx: EntityManager,
    principal: AuthenticatedProviderPrincipal,
    policy: ResourcePolicy,
    request: ResourceRequest,
  ): Promise<void> {
    const db = tx;
    if (policy.resource === 'operator') {
      const grants = await db.execute(
        `select action from operator_grants where issuer = ? and subject = ? and action = ? and revoked_at is null and granted_at <= clock_timestamp() for share`,
        [principal.issuer, principal.subject, policy.capability],
      );
      if (!grants.length)
        throw new ForbiddenException({ errorCode: 'OPERATOR_PERMISSION_REQUIRED' });
      return;
    }
    const provider = principal.providerId;
    const bindings = await db.execute(
      `select provider_id from provider_principal_bindings where issuer = ? and subject = ? and provider_id = ? and revoked_at is null and granted_at <= clock_timestamp() for share`,
      [principal.issuer, principal.subject, provider ?? ''],
    );
    if (!bindings.length) throw new ForbiddenException({ errorCode: 'PROVIDER_BINDING_REQUIRED' });
    if (policy.resource === 'player') {
      const balance = request.body?.initialBalance as
        { amount?: unknown; currency?: unknown } | undefined;
      const capabilities = ['wallet.create'];
      // Any nonzero/invalid representation requires credit permission; DTO validation still applies.
      if (typeof balance?.amount !== 'string' || !/^0+\.00$/.test(balance.amount))
        capabilities.push('wallet.opening.credit');
      for (const capability of capabilities.sort()) {
        const grants = await db.execute(
          `select capability from provider_player_grants where provider_id = ? and player_id = ? and currency = ? and capability = ? and revoked_at is null and granted_at <= clock_timestamp() for share`,
          [provider, request.body?.playerId ?? '', balance?.currency ?? '', capability],
        );
        if (!grants.length) throw new NotFoundException({ errorCode: 'RESOURCE_NOT_FOUND' });
      }
      return;
    }
    let walletId: unknown;
    let capability: WalletCapability;
    if (policy.resource === 'transaction') {
      const rows = await db.execute<Array<{ wallet_id: string }>>(
        `select wallet_id from wager_transactions where provider_id = ? and kind <> 'OPENING' and ${policy.external ? 'external_transaction_id = ?' : 'id = ?::uuid'}`,
        [
          provider,
          policy.external
            ? request.params?.externalTransactionId
            : this.uuid(request.params?.transactionId),
        ],
      );
      if (!rows.length) throw new NotFoundException({ errorCode: 'RESOURCE_NOT_FOUND' });
      walletId = rows[0]!.wallet_id;
      capability = 'transaction.read_own';
    } else {
      walletId = policy.parameter === 'body' ? request.body?.walletId : request.params?.walletId;
      capability = policy.capability;
    }
    const grants = await db.execute(
      `select capability from provider_wallet_grants where provider_id = ? and wallet_id = ?::uuid and capability = ? and revoked_at is null and granted_at <= clock_timestamp() for share`,
      [provider, this.uuid(walletId), capability],
    );
    if (!grants.length) throw new NotFoundException({ errorCode: 'RESOURCE_NOT_FOUND' });
  }

  private uuid(value: unknown): string {
    if (
      typeof value !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    )
      throw new NotFoundException({ errorCode: 'RESOURCE_NOT_FOUND' });
    return value;
  }
}

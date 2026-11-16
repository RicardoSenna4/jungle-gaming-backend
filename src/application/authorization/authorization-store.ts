import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import type {
  OperatorCapability,
  PlayerCapability,
  WalletCapability,
} from '../../infrastructure/database/mikro-orm/authorization.entities';

export interface AdministrativeActor {
  issuer: string;
  subject: string;
  source: string;
}
export type AuthorizationGrant =
  | { kind: 'binding'; issuer: string; subject: string; providerId: string }
  | { kind: 'wallet'; providerId: string; walletId: string; capability: WalletCapability }
  | {
      kind: 'player';
      providerId: string;
      playerId: string;
      currency: string;
      capability: PlayerCapability;
    }
  | { kind: 'operator'; issuer: string; subject: string; action: OperatorCapability };

const definitions = {
  binding: {
    table: 'provider_principal_bindings',
    columns: ['issuer', 'subject', 'provider_id'],
    fields: ['issuer', 'subject', 'providerId'],
  },
  wallet: {
    table: 'provider_wallet_grants',
    columns: ['provider_id', 'wallet_id', 'capability'],
    fields: ['providerId', 'walletId', 'capability'],
  },
  player: {
    table: 'provider_player_grants',
    columns: ['provider_id', 'player_id', 'currency', 'capability'],
    fields: ['providerId', 'playerId', 'currency', 'capability'],
  },
  operator: {
    table: 'operator_grants',
    columns: ['issuer', 'subject', 'action'],
    fields: ['issuer', 'subject', 'action'],
  },
} as const;

/** Trusted administrative API only. Never expose actor/source or grants as client DTOs. */
@Injectable()
export class AuthorizationStore {
  constructor(private readonly em: EntityManager) {}

  async grant(grant: AuthorizationGrant, actor: AdministrativeActor): Promise<void> {
    const { table, columns, fields } = definitions[grant.kind];
    const record = grant as unknown as Record<string, string>;
    const values = fields.map((field) => record[field]);
    const predicate = columns.map((column) => `${column} = ?`).join(' and ');
    await this.em.transactional(async (tx) => {
      const db = tx;
      // Unique keys serialize simultaneous provisions; retries of active grants are no-ops.
      await db.execute(
        `insert into ${table} (${columns.join(',')}, source, actor_issuer, actor_subject)
        values (${values.map(() => '?').join(',')}, ?, ?, ?) on conflict do nothing`,
        [...values, actor.source, actor.issuer, actor.subject],
      );
      const rows = await db.execute<Array<{ revoked_at: Date | null }>>(
        `select revoked_at from ${table} where ${predicate} for update`,
        values,
      );
      if (rows[0]?.revoked_at) {
        await db.execute(
          `update ${table} set revoked_at = null, granted_at = clock_timestamp(), source = ?, actor_issuer = ?, actor_subject = ? where ${predicate}`,
          [actor.source, actor.issuer, actor.subject, ...values],
        );
      }
    });
  }

  async revoke(grant: AuthorizationGrant, actor: AdministrativeActor): Promise<void> {
    const { table, columns, fields } = definitions[grant.kind];
    const record = grant as unknown as Record<string, string>;
    await this.em.transactional(async (tx) => {
      await tx.execute(
        `update ${table} set revoked_at = greatest(clock_timestamp(), granted_at), source = ?, actor_issuer = ?, actor_subject = ?
        where ${columns.map((column) => `${column} = ?`).join(' and ')} and revoked_at is null`,
        [actor.source, actor.issuer, actor.subject, ...fields.map((field) => record[field])],
      );
    });
  }
}

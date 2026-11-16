import { WalletOrmEntity } from './entities';
import { Entity, Index, ManyToOne, PrimaryKey, Property } from '@mikro-orm/core';

export const walletCapabilities = [
  'balance.read',
  'wager.submit',
  'transaction.read_own',
  'ledger.read_all',
  'reconcile',
] as const;
export const playerCapabilities = ['wallet.create', 'wallet.opening.credit'] as const;
export const operatorCapabilities = ['quarantine.read', 'quarantine.resolve'] as const;
export type WalletCapability = (typeof walletCapabilities)[number];
export type PlayerCapability = (typeof playerCapabilities)[number];
export type OperatorCapability = (typeof operatorCapabilities)[number];

abstract class GrantMetadata {
  @Property({ fieldName: 'granted_at', columnType: 'timestamptz', defaultRaw: 'clock_timestamp()' })
  grantedAt: Date = new Date();

  @Property({ fieldName: 'revoked_at', columnType: 'timestamptz', nullable: true })
  revokedAt?: Date;

  @Property({ columnType: 'text' })
  source!: string;

  @Property({ fieldName: 'actor_issuer', columnType: 'text' })
  actorIssuer!: string;

  @Property({ fieldName: 'actor_subject', columnType: 'text' })
  actorSubject!: string;
}

@Entity({ tableName: 'provider_principal_bindings' })
export class ProviderPrincipalBinding extends GrantMetadata {
  @PrimaryKey({ columnType: 'text' }) issuer!: string;
  @PrimaryKey({ columnType: 'text' }) subject!: string;
  @PrimaryKey({ fieldName: 'provider_id', columnType: 'text' }) providerId!: string;
}

@Entity({ tableName: 'provider_wallet_grants' })
@Index({ name: 'provider_wallet_grants_wallet_idx', properties: ['walletId', 'providerId'] })
export class ProviderWalletGrant extends GrantMetadata {
  @PrimaryKey({ fieldName: 'provider_id', columnType: 'text' }) providerId!: string;
  @ManyToOne({
    entity: () => WalletOrmEntity,
    fieldName: 'wallet_id',
    mapToPk: true,
    primary: true,
    deleteRule: 'restrict',
    foreignKeyName: 'provider_wallet_grants_wallet_id_fkey',
  })
  walletId!: string;
  @PrimaryKey({ columnType: 'text' }) capability!: WalletCapability;
}

@Entity({ tableName: 'provider_player_grants' })
export class ProviderPlayerGrant extends GrantMetadata {
  @PrimaryKey({ fieldName: 'provider_id', columnType: 'text' }) providerId!: string;
  @PrimaryKey({ fieldName: 'player_id', columnType: 'text' }) playerId!: string;
  @PrimaryKey({ length: 3 }) currency!: string;
  @PrimaryKey({ columnType: 'text' }) capability!: PlayerCapability;
}

@Entity({ tableName: 'operator_grants' })
export class OperatorGrant extends GrantMetadata {
  @PrimaryKey({ columnType: 'text' }) issuer!: string;
  @PrimaryKey({ columnType: 'text' }) subject!: string;
  @PrimaryKey({ columnType: 'text' }) action!: OperatorCapability;
}

@Entity({ tableName: 'authorization_audit' })
@Index({
  name: 'authorization_audit_actor_idx',
  properties: ['actorIssuer', 'actorSubject', 'occurredAt'],
})
@Index({ name: 'authorization_audit_resource_idx', properties: ['resource', 'occurredAt'] })
export class AuthorizationAudit {
  @PrimaryKey({ type: 'uuid' }) id!: string;
  @Property({ fieldName: 'actor_issuer', columnType: 'text' }) actorIssuer!: string;
  @Property({ fieldName: 'actor_subject', columnType: 'text' }) actorSubject!: string;
  @Property({ fieldName: 'provider_id', columnType: 'text', nullable: true }) providerId?: string;
  @Property({ columnType: 'text' }) action!: string;
  @Property({ columnType: 'text' }) resource!: string;
  @Property({ columnType: 'text' }) decision!: 'allow' | 'deny' | 'grant' | 'revoke';
  @Property({ columnType: 'text' }) source!: string;
  @Property({ fieldName: 'correlation_id', type: 'uuid' }) correlationId!: string;
  @Property({
    fieldName: 'occurred_at',
    columnType: 'timestamptz',
    defaultRaw: 'clock_timestamp()',
  })
  occurredAt: Date = new Date();
}

export const authorizationEntities = [
  ProviderPrincipalBinding,
  ProviderWalletGrant,
  ProviderPlayerGrant,
  OperatorGrant,
  AuthorizationAudit,
];

import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/core';
@Entity({ tableName: 'quarantine_redrive_attempts' })
@Unique({ properties: ['consumerName', 'messageId', 'requestKey'] })
export class QuarantineRedriveAttempt {
  @PrimaryKey({ type: 'uuid' }) id!: string;
  @Property({ fieldName: 'consumer_name', length: 128 }) consumerName!: string;
  @Property({ fieldName: 'message_id', length: 255 }) messageId!: string;
  @Property({ fieldName: 'request_key', length: 128 }) requestKey!: string;
  @Property({ fieldName: 'actor_issuer', columnType: 'text' }) actorIssuer!: string;
  @Property({ fieldName: 'actor_subject', columnType: 'text' }) actorSubject!: string;
  @Property({ columnType: 'text' }) justification!: string;
  @Property({ columnType: 'text' }) payload!: string;
  @Property({ fieldName: 'queue_url', columnType: 'text' }) queueUrl!: string;
  @Property({ fieldName: 'group_id', length: 128 }) groupId!: string;
  @Property({ length: 16 }) state!: string;
  @Property({ fieldName: 'lease_token', type: 'uuid' }) leaseToken!: string;
  @Property({ fieldName: 'lease_until', columnType: 'timestamptz' }) leaseUntil!: Date;
  @Property({ fieldName: 'created_at', columnType: 'timestamptz', defaultRaw: 'clock_timestamp()' })
  createdAt!: Date;
  @Property({ fieldName: 'updated_at', columnType: 'timestamptz', defaultRaw: 'clock_timestamp()' })
  updatedAt!: Date;
  @Property({ fieldName: 'error_code', length: 64, nullable: true }) errorCode?: string;
}
@Entity({ tableName: 'quarantine_operation_events' })
export class QuarantineOperationEvent {
  @PrimaryKey({ type: 'uuid' }) id!: string;
  @Property({ fieldName: 'attempt_id', type: 'uuid' }) attemptId!: string;
  @Property({ fieldName: 'actor_issuer', columnType: 'text' }) actorIssuer!: string;
  @Property({ fieldName: 'actor_subject', columnType: 'text' }) actorSubject!: string;
  @Property({ length: 32 }) event!: string;
  @Property({ columnType: 'text' }) justification!: string;
  @Property({
    fieldName: 'occurred_at',
    columnType: 'timestamptz',
    defaultRaw: 'clock_timestamp()',
  })
  occurredAt!: Date;
}

import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/core';

@Entity({ tableName: 'message_quarantine' })
@Unique({ properties: ['consumerName', 'messageId'] })
@Index({ properties: ['status', 'lastSeenAt'] })
export class QuarantineOrmEntity {
  @PrimaryKey({ fieldName: 'message_id' })
  messageId!: string;

  @PrimaryKey({ fieldName: 'consumer_name' })
  consumerName!: string;

  @Property({ length: 64 })
  reason!: string;

  @Property({ fieldName: 'raw_payload', columnType: 'text' })
  rawPayload!: string;

  @Property({ fieldName: 'receive_count', default: 1 })
  receiveCount = 1;

  @Property({ length: 16, default: 'OPEN' })
  status: 'OPEN' | 'RELEASED' | 'RESOLVED' = 'OPEN';

  @Property({ fieldName: 'first_seen_at', onCreate: () => new Date() })
  firstSeenAt?: Date;

  @Property({ fieldName: 'last_seen_at', onCreate: () => new Date(), onUpdate: () => new Date() })
  lastSeenAt?: Date;

  @Property({ fieldName: 'resolved_at', nullable: true })
  resolvedAt?: Date;

  @Property({ fieldName: 'resolution_note', nullable: true, columnType: 'text' })
  resolutionNote?: string;
}

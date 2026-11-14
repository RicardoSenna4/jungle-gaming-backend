import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

@Entity({ tableName: 'service_metadata' })
export class ServiceMetadataEntity {
  @PrimaryKey()
  key!: string;

  @Property()
  value!: string;
}

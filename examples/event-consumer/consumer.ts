import { Client } from 'pg';
import { createHash } from 'node:crypto';
import { SQSClient, DeleteMessageCommand, Message } from '@aws-sdk/client-sqs';

export const schema = `create schema if not exists reference_events;
create table if not exists reference_events.processed(event_id uuid primary key,payload_hash text not null,event_type text not null,processed_at timestamptz not null default now());
create table if not exists reference_events.effects(event_id uuid primary key references reference_events.processed(event_id),event_type text not null);
create table if not exists reference_events.invalid(message_id text primary key,reason text not null,received_at timestamptz not null default now());`;
const types = [
  'WagerTransactionProcessed',
  'WagerTransactionRejected',
  'WagerTransactionPendingReference',
  'WalletBalanceChanged',
];
export class ReferenceEventConsumer {
  constructor(
    private readonly db: Client,
    private readonly sqs: SQSClient,
    private readonly queue: string,
  ) {}
  async handle(message: Message) {
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(message.Body ?? '');
      if (
        !envelope ||
        Array.isArray(envelope) ||
        envelope.version !== 1 ||
        typeof envelope.eventId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(envelope.eventId) ||
        !types.includes(String(envelope.eventType)) ||
        typeof envelope.aggregateId !== 'string' ||
        typeof envelope.correlationId !== 'string' ||
        typeof envelope.occurredAt !== 'string' ||
        !Number.isFinite(Date.parse(envelope.occurredAt)) ||
        !envelope.data ||
        typeof envelope.data !== 'object' ||
        Array.isArray(envelope.data)
      )
        throw new Error();
    } catch {
      await this.db.query(
        'insert into reference_events.invalid(message_id,reason) values($1,$2) on conflict do nothing',
        [
          message.MessageId ??
            createHash('sha256')
              .update(message.Body ?? '')
              .digest('hex'),
          'INVALID_ENVELOPE',
        ],
      );
      await this.ack(message);
      return 'invalid';
    }
    const hash = createHash('sha256').update(message.Body!).digest('hex');
    await this.db.query('begin');
    try {
      const inserted = await this.db.query(
        'insert into reference_events.processed(event_id,payload_hash,event_type) values($1,$2,$3) on conflict do nothing returning event_id',
        [envelope.eventId, hash, envelope.eventType],
      );
      const existing = await this.db.query(
        'select payload_hash from reference_events.processed where event_id=$1',
        [envelope.eventId],
      );
      if (existing.rows[0].payload_hash !== hash) throw new Error('EVENT_ID_PAYLOAD_CONFLICT');
      if (inserted.rowCount)
        await this.db.query(
          'insert into reference_events.effects(event_id,event_type) values($1,$2)',
          [envelope.eventId, envelope.eventType],
        );
      await this.db.query('commit');
    } catch (error) {
      await this.db.query('rollback');
      throw error;
    }
    await this.ack(message);
    return 'processed';
  }
  protected async ack(message: Message) {
    if (message.ReceiptHandle)
      await this.sqs.send(
        new DeleteMessageCommand({ QueueUrl: this.queue, ReceiptHandle: message.ReceiptHandle }),
      );
  }
}

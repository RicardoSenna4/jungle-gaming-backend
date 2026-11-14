import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { GetQueueAttributesCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

@Injectable()
export class SqsInfrastructureClient implements OnModuleDestroy {
  private readonly endpoint = process.env.SQS_ENDPOINT;
  private readonly client = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    ...(this.endpoint ? { endpoint: this.endpoint } : {}),
    ...(this.endpoint
      ? {
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
          },
        }
      : {}),
  });

  get commandQueueUrl(): string {
    return this.resolveQueueUrl(process.env.SQS_QUEUE_URL, 'wager-transactions.fifo');
  }

  get eventsQueueUrl(): string {
    return this.resolveQueueUrl(process.env.SQS_EVENTS_QUEUE_URL, 'wager-events.fifo');
  }

  async publishEvent(payload: Record<string, unknown>, aggregateId: string): Promise<void> {
    const eventId = typeof payload.eventId === 'string' ? payload.eventId : undefined;
    if (!eventId) throw new Error('OUTBOX_EVENT_ID_REQUIRED');
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.eventsQueueUrl,
        MessageBody: JSON.stringify(payload),
        MessageGroupId: aggregateId,
        MessageDeduplicationId: eventId,
      }),
    );
  }

  async assertQueueReachable(queueUrl: string): Promise<void> {
    await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ['QueueArn'],
      }),
    );
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }

  private resolveQueueUrl(override: string | undefined, queueName: string): string {
    if (override) return override;
    const endpoint = this.endpoint ?? 'http://localhost:4566';
    return `${endpoint.replace(/\/$/, '')}/000000000000/${queueName}`;
  }
}

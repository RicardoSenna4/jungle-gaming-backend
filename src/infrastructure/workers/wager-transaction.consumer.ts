import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  Message,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  FinancialProcessingError,
  SubmitInput,
  WagerProcessingService,
} from '../../application/wager-processing.service';
import { MetricsService } from '../telemetry/metrics.service';

interface WagerTransactionEnvelope {
  messageId: string;
  type: 'WagerTransactionRequested';
  occurredAt: string;
  data: SubmitInput & { idempotencyKey: string };
}

export interface ConsumerHandleResult {
  acknowledged: boolean;
  transactionId?: string;
  status?: string;
  failureCode?: string;
}

@Injectable()
export class WagerTransactionConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WagerTransactionConsumer.name);
  private readonly consumerName = process.env.SQS_CONSUMER_NAME ?? 'wager-transaction-consumer-v1';
  private readonly queueUrl =
    process.env.SQS_QUEUE_URL ??
    `${process.env.SQS_ENDPOINT ?? 'http://localhost:4566'}/000000000000/wager-transactions.fifo`;
  private readonly dlqQueueUrl =
    process.env.SQS_DLQ_QUEUE_URL ??
    `${process.env.SQS_ENDPOINT ?? 'http://localhost:4566'}/000000000000/wager-transactions-dlq.fifo`;
  private readonly sqs = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
  private stopping = false;
  private polling?: Promise<void>;
  private readonly inFlight = new Set<Promise<unknown>>();
  private lastDlqSampleAt = 0;

  constructor(
    private readonly service: WagerProcessingService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  onModuleInit(): void {
    if (process.env.ENABLE_SQS_CONSUMER === 'true') this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
    this.sqs.destroy();
  }

  start(): void {
    if (this.polling) return;
    this.stopping = false;
    this.polling = this.pollLoop();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.polling;
    await Promise.allSettled([...this.inFlight]);
    this.polling = undefined;
  }

  async handleMessage(message: Message): Promise<ConsumerHandleResult> {
    const startedAt = Date.now();
    let envelope: WagerTransactionEnvelope;
    try {
      envelope = this.parseEnvelope(message);
    } catch {
      this.metrics?.increment('sqs_messages_unacked_total', { reason: 'invalid_message' });
      this.recordMessageDuration(startedAt);
      return { acknowledged: false, failureCode: 'INVALID_MESSAGE' };
    }
    try {
      const result = await this.service.process(envelope.data.idempotencyKey, envelope.data, 0, {
        consumerName: this.consumerName,
        messageId: envelope.messageId,
      });
      this.metrics?.increment('wager_transactions_total', {
        source: 'sqs',
        kind: envelope.data.kind.toLowerCase(),
        status: result.status.toLowerCase(),
      });
      this.logger.log(
        JSON.stringify({
          event: 'wager_sqs_processed',
          correlationId: envelope.data.externalTransactionId,
          messageId: envelope.messageId,
          transactionId: result.transactionId,
          walletId: envelope.data.walletId,
          providerId: envelope.data.providerId,
          status: result.status,
        }),
      );
      this.recordMessageDuration(startedAt);
      return {
        acknowledged: true,
        transactionId: result.transactionId,
        status: result.status,
        failureCode: result.failureCode,
      };
    } catch (error) {
      if (error instanceof FinancialProcessingError) {
        this.metrics?.increment('sqs_messages_unacked_total', { reason: error.code });
        this.recordMessageDuration(startedAt);
        return { acknowledged: false, failureCode: error.code };
      }
      this.metrics?.increment('sqs_messages_unacked_total', { reason: 'infrastructure_error' });
      this.recordMessageDuration(startedAt);
      return { acknowledged: false };
    }
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        const response = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 1,
            VisibilityTimeout: Number(process.env.SQS_VISIBILITY_TIMEOUT ?? 30),
          }),
        );
        this.metrics?.increment('sqs_messages_received_total', {}, response.Messages?.length ?? 0);
        if (Date.now() - this.lastDlqSampleAt >= 30_000) await this.refreshDlqGauge();
        for (const message of response.Messages ?? []) {
          const task = this.handleAndAck(message);
          this.inFlight.add(task);
          void task.then(
            () => this.inFlight.delete(task),
            () => this.inFlight.delete(task),
          );
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  private async handleAndAck(message: Message): Promise<void> {
    const result = await this.handleMessage(message);
    if (!result.acknowledged || !message.ReceiptHandle) return;
    await this.sqs.send(
      new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle }),
    );
    this.metrics?.increment('sqs_messages_acknowledged_total');
  }

  private async refreshDlqGauge(): Promise<void> {
    const response = await this.sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: this.dlqQueueUrl,
        AttributeNames: ['ApproximateNumberOfMessages'],
      }),
    );
    this.metrics?.setGauge(
      'sqs_dlq_messages',
      Number(response.Attributes?.ApproximateNumberOfMessages ?? 0),
    );
    this.lastDlqSampleAt = Date.now();
  }

  private parseEnvelope(message: Message): WagerTransactionEnvelope {
    if (!message.Body) throw new Error('INVALID_MESSAGE');
    const envelope = JSON.parse(message.Body) as Partial<WagerTransactionEnvelope>;
    if (
      typeof envelope.messageId !== 'string' ||
      envelope.type !== 'WagerTransactionRequested' ||
      typeof envelope.data !== 'object' ||
      envelope.data === null ||
      typeof envelope.data.idempotencyKey !== 'string' ||
      typeof envelope.data.providerId !== 'string' ||
      (process.env.ALLOWED_PROVIDER_IDS?.split(',').filter(Boolean).length &&
        !process.env.ALLOWED_PROVIDER_IDS.split(',').includes(envelope.data.providerId))
    ) {
      throw new Error('INVALID_MESSAGE');
    }
    return envelope as WagerTransactionEnvelope;
  }

  private recordMessageDuration(startedAt: number): void {
    this.metrics?.observe('wager_processing_duration_seconds', (Date.now() - startedAt) / 1_000, {
      source: 'sqs',
    });
  }
}

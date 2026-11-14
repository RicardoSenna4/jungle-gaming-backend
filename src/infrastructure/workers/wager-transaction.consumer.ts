import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  FinancialProcessingError,
  SubmitInput,
  WagerProcessingService,
} from '../../application/wager-processing.service';

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
  private readonly consumerName = process.env.SQS_CONSUMER_NAME ?? 'wager-transaction-consumer-v1';
  private readonly queueUrl =
    process.env.SQS_QUEUE_URL ??
    `${process.env.SQS_ENDPOINT ?? 'http://localhost:4566'}/000000000000/wager-transactions.fifo`;
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

  constructor(private readonly service: WagerProcessingService) {}

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
    let envelope: WagerTransactionEnvelope;
    try {
      envelope = this.parseEnvelope(message);
    } catch {
      return { acknowledged: false, failureCode: 'INVALID_MESSAGE' };
    }
    try {
      const result = await this.service.process(envelope.data.idempotencyKey, envelope.data, 0, {
        consumerName: this.consumerName,
        messageId: envelope.messageId,
      });
      return {
        acknowledged: true,
        transactionId: result.transactionId,
        status: result.status,
        failureCode: result.failureCode,
      };
    } catch (error) {
      if (error instanceof FinancialProcessingError) {
        return { acknowledged: false, failureCode: error.code };
      }
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
}

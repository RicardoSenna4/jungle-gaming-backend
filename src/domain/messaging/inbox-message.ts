import { InvalidDomainOperationError, InvalidTransactionStateError } from '../errors';

export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: InboxMessageState): InboxMessage {
    if (!props.messageId.trim() || !props.consumerName.trim()) {
      throw new InvalidDomainOperationError('INVALID_INBOX_ID');
    }
    if (!/^[a-f0-9]{64}$/i.test(props.payloadHash)) {
      throw new InvalidDomainOperationError('INVALID_PAYLOAD_HASH');
    }
    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      new Date(props.receivedAt),
      props.processedAt ? new Date(props.processedAt) : undefined,
    );
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      new Date(state.receivedAt),
      state.processedAt ? new Date(state.processedAt) : undefined,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt ? new Date(this._processedAt) : undefined;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed())
      throw new InvalidTransactionStateError('Inbox message is already processed');
    this._processedAt = new Date(at);
  }
}

export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidTransactionStateError extends DomainError {
  constructor(message = 'Transaction is already terminal') {
    super(message, 'INVALID_TRANSACTION_STATE');
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message = 'Invalid money value') {
    super(message, 'INVALID_MONEY');
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor() {
    super('CURRENCY_MISMATCH', 'CURRENCY_MISMATCH');
  }
}

export class InvalidDomainOperationError extends DomainError {
  constructor(code: string, message = code) {
    super(message, code);
  }
}

import { JsonLogger } from '../../src/infrastructure/telemetry/json-logger';

describe('JsonLogger', () => {
  it('emits a valid JSON line with safe operational fields and redacts secrets', () => {
    const lines: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((line: string) => {
      lines.push(line);
      return true;
    }) as typeof process.stdout.write;
    try {
      const logger = new JsonLogger();
      logger.log(
        JSON.stringify({
          event: 'wager_processed',
          walletId: 'wallet-a',
          password: 'private-secret',
          money: { amount: '10.00', currency: 'BRL' },
          correlationId: 'correlation-1',
        }),
        'WagerService',
      );
    } finally {
      process.stdout.write = original;
    }
    const output = JSON.parse(lines[0]!);
    expect(output).toMatchObject({
      level: 'info',
      context: 'WagerService',
      event: 'wager_processed',
      walletId: 'wallet-a',
      correlationId: 'correlation-1',
    });
    expect(lines[0]).not.toContain('private-secret');
    expect(lines[0]).not.toContain('10.00');
  });
});

import { LoggerService } from '@nestjs/common';

// Only expose approved operational fields; never serialize full financial payloads,
// credentials, request headers, arbitrary stack traces or raw error objects.
const SAFE_FIELDS = [
  'event', 'correlationId', 'messageId', 'transactionId', 'walletId',
  'providerId', 'status', 'idempotentReplay', 'outboxId', 'eventType',
  'errorCode', 'errorName', 'checkedEntries', 'context',
] as const;

export class JsonLogger implements LoggerService {
  private emit(level: string, message: unknown, context?: string): void {
    let source: Record<string, unknown> = {};
    if (typeof message === 'string') {
      try {
        const parsed: unknown = JSON.parse(message);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          source = parsed as Record<string, unknown>;
        } else source = { event: 'application_log' };
      } catch {
        source = { event: 'application_log' };
      }
    } else if (message && typeof message === 'object') {
      source = message as Record<string, unknown>;
    }
    const safe: Record<string, unknown> = {};
    for (const field of SAFE_FIELDS) {
      const value = source[field];
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        safe[field] = value;
      }
    }
    const record = {
      timestamp: new Date().toISOString(),
      level,
      ...(context ? { context } : {}),
      ...safe,
    };
    (level === 'error' ? process.stderr : process.stdout).write(JSON.stringify(record) + '\n');
  }

  log(message: unknown, context?: string): void { this.emit('info', message, context); }
  warn(message: unknown, context?: string): void { this.emit('warn', message, context); }
  error(message: unknown, _trace?: string, context?: string): void { this.emit('error', message, context); }
  debug(message: unknown, context?: string): void { this.emit('debug', message, context); }
  verbose(message: unknown, context?: string): void { this.emit('verbose', message, context); }
  fatal(message: unknown, context?: string): void { this.emit('fatal', message, context); }
}

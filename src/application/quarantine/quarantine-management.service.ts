import {
  BadRequestException,
  ConflictException,
  Injectable,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { SqsInfrastructureClient } from '../../infrastructure/workers/sqs-infrastructure.client';
import { WagerTransactionConsumer } from '../../infrastructure/workers/wager-transaction.consumer';
import type { AuthenticatedProviderPrincipal } from '../../interfaces/http/oidc-jwt.verifier';

interface Actor {
  issuer: string;
  subject: string;
}
interface Attempt {
  id: string;
  consumer_name: string;
  message_id: string;
  request_key: string;
  state: string;
  payload: string;
  queue_url: string;
  group_id: string;
  lease_token: string;
  lease_until: Date;
  leased?: boolean;
}
interface Filters {
  status?: string;
  consumer?: string;
  reason?: string;
  cursor?: string;
  limit?: string;
}

@Injectable()
export class QuarantineManagementService {
  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SqsInfrastructureClient,
  ) {}

  async page(filters: Filters) {
    const limit = filters.limit === undefined ? 50 : Number(filters.limit);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (filters.status && !['OPEN', 'REDRIVING', 'RELEASED', 'RESOLVED'].includes(filters.status))
    )
      throw new BadRequestException({ errorCode: 'INVALID_QUARANTINE_FILTER' });
    const clauses: string[] = [];
    const params: unknown[] = [];
    for (const [column, value] of [
      ['status', filters.status],
      ['consumer_name', filters.consumer],
      ['reason', filters.reason],
    ])
      if (value !== undefined) {
        if (typeof value !== 'string' || value.length > 128) throw new BadRequestException();
        clauses.push(`${column} = ?`);
        params.push(value);
      }
    if (filters.cursor) {
      try {
        const cursor = JSON.parse(Buffer.from(filters.cursor, 'base64url').toString('utf8')) as {
          at: string;
          consumer: string;
          message: string;
        };
        if (
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(cursor.at) ||
          !Number.isFinite(Date.parse(cursor.at)) ||
          typeof cursor.consumer !== 'string' ||
          typeof cursor.message !== 'string' ||
          cursor.consumer.length > 128 ||
          cursor.message.length > 255
        )
          throw new Error();
        clauses.push('(last_seen_at,consumer_name,message_id) < (?::timestamptz,?,?)');
        params.push(cursor.at, cursor.consumer, cursor.message);
      } catch {
        throw new BadRequestException({ errorCode: 'INVALID_QUARANTINE_CURSOR' });
      }
    }
    params.push(limit + 1);
    const rows = await this.em.execute<Array<Record<string, unknown>>>(
      `select consumer_name, message_id, status, reason, receive_count, first_seen_at, last_seen_at, resolved_at,
      to_char(last_seen_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at
      from message_quarantine ${clauses.length ? 'where ' + clauses.join(' and ') : ''} order by last_seen_at desc,consumer_name desc,message_id desc limit ?`,
      params,
    );
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items: items.map((row) => {
        const result = { ...row };
        delete result.cursor_at;
        return result;
      }),
      ...(hasMore && last
        ? {
            nextCursor: Buffer.from(
              JSON.stringify({
                at: last.cursor_at,
                consumer: last.consumer_name,
                message: last.message_id,
              }),
            ).toString('base64url'),
          }
        : {}),
    };
  }

  async history(consumer: string, message: string) {
    const attempts = await this.em.execute(
      `select id, request_key, actor_issuer, actor_subject, justification, state, lease_until, created_at, updated_at, error_code from quarantine_redrive_attempts where consumer_name = ? and message_id = ? order by created_at desc limit 100`,
      [consumer, message],
    );
    const events = await this.em.execute(
      `select attempt_id, actor_issuer, actor_subject, event, justification, occurred_at from quarantine_operation_events where consumer_name = ? and message_id = ? order by occurred_at desc limit 100`,
      [consumer, message],
    );
    return { attempts, events };
  }

  async resolve(
    consumer: string,
    message: string,
    justification: unknown,
    principal?: AuthenticatedProviderPrincipal,
  ) {
    if (typeof justification !== 'string' || !justification.trim() || justification.length > 1024)
      throw new BadRequestException({ errorCode: 'JUSTIFICATION_REQUIRED' });
    const actor = this.actor(principal);
    return this.em.transactional(async (tx) => {
      const rows = await tx.execute<Array<{ status: string }>>(
        'select status from message_quarantine where consumer_name = ? and message_id = ? for update',
        [consumer, message],
      );
      if (!rows.length) throw new NotFoundException({ errorCode: 'QUARANTINE_NOT_FOUND' });
      if (rows[0]!.status === 'REDRIVING')
        throw new ConflictException({ errorCode: 'REDRIVE_IN_PROGRESS' });
      const result = await tx.execute<Array<Record<string, unknown>>>(
        "update message_quarantine set status = 'RESOLVED', resolution_note = ?, resolved_at = clock_timestamp() where consumer_name = ? and message_id = ? returning reason,receive_count,first_seen_at,last_seen_at,resolved_at",
        [justification.trim(), consumer, message],
      );
      await tx.execute(
        "insert into quarantine_operation_events (id,consumer_name,message_id,actor_issuer,actor_subject,event,justification) values (?,?,?,?,?,'RESOLVED',?)",
        [randomUUID(), consumer, message, actor.issuer, actor.subject, justification.trim()],
      );
      const row = result[0]!;
      return {
        consumerName: consumer,
        messageId: message,
        status: 'RESOLVED',
        reason: row.reason,
        receiveCount: row.receive_count,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        resolvedAt: row.resolved_at,
        resolutionNote: justification.trim(),
      };
    });
  }

  private actor(principal?: AuthenticatedProviderPrincipal): Actor {
    if ((process.env.AUTH_MODE ?? 'challenge') === 'challenge')
      return { issuer: 'challenge-local', subject: 'unverified-local-operator' };
    if (!principal)
      throw new ServiceUnavailableException({ errorCode: 'AUTHENTICATED_ACTOR_REQUIRED' });
    return principal;
  }

  async redrive(
    consumer: string,
    message: string,
    key: string | undefined,
    justification: unknown,
    principal?: AuthenticatedProviderPrincipal,
  ) {
    if (
      !key ||
      key.length > 128 ||
      !key.trim() ||
      typeof justification !== 'string' ||
      !justification.trim() ||
      justification.length > 1024
    )
      throw new BadRequestException({ errorCode: 'REDRIVE_KEY_AND_JUSTIFICATION_REQUIRED' });
    if (consumer !== (process.env.SQS_CONSUMER_NAME ?? 'wager-transaction-consumer-v1'))
      throw new UnprocessableEntityException({ errorCode: 'UNSUPPORTED_CONSUMER' });
    const actor = this.actor(principal);
    const token = randomUUID();
    // Separate transactions are intentional: durable claim must precede SQS publication.
    const db = this.em.fork({ useContext: false, keepTransactionContext: false });
    const claimed = await db
      .transactional(async (tx) => {
        const rows = await tx.execute<Array<{ status: string; raw_payload: string }>>(
          'select status,raw_payload from message_quarantine where consumer_name = ? and message_id = ? for update',
          [consumer, message],
        );
        if (!rows.length) throw new NotFoundException({ errorCode: 'QUARANTINE_NOT_FOUND' });
        const attempts = await tx.execute<Attempt[]>(
          'select *, lease_until > clock_timestamp() as leased from quarantine_redrive_attempts where consumer_name = ? and message_id = ? and request_key = ? for update',
          [consumer, message, key],
        );
        const existing = attempts[0];
        if (existing && existing.state !== 'PENDING') return { attempt: existing, publish: false };
        if (existing && existing.leased)
          throw new ConflictException({ errorCode: 'REDRIVE_IN_PROGRESS' });
        if (!existing && rows[0]!.status !== 'OPEN')
          throw new ConflictException({ errorCode: 'REDRIVE_RECOVERY_OR_DISPOSITION_REQUIRED' });
        let attempt = existing;
        if (!attempt) {
          let envelope;
          try {
            envelope = WagerTransactionConsumer.parseEnvelope({ Body: rows[0]!.raw_payload });
          } catch {
            throw new UnprocessableEntityException({ errorCode: 'INVALID_PAYLOAD_NOT_REDRIVABLE' });
          }
          if (envelope.data.walletId.length > 128)
            throw new UnprocessableEntityException({ errorCode: 'INVALID_PAYLOAD_NOT_REDRIVABLE' });
          const id = randomUUID();
          await tx.execute(
            `insert into quarantine_redrive_attempts (id,consumer_name,message_id,request_key,actor_issuer,actor_subject,justification,payload,queue_url,group_id,state,lease_token,lease_until) values (?,?,?,?,?,?,?,?,?,?,'PENDING',?,clock_timestamp()+interval '60 seconds')`,
            [
              id,
              consumer,
              message,
              key,
              actor.issuer,
              actor.subject,
              justification.trim(),
              rows[0]!.raw_payload,
              this.sqs.commandQueueUrl,
              envelope.data.walletId,
              token,
            ],
          );
          attempt = (
            await tx.execute<Attempt[]>('select * from quarantine_redrive_attempts where id = ?', [
              id,
            ])
          )[0]!;
        } else {
          await tx.execute(
            "update quarantine_redrive_attempts set lease_token = ?, lease_until = clock_timestamp()+interval '60 seconds', updated_at = clock_timestamp() where id = ?",
            [token, attempt.id],
          );
          attempt.lease_token = token;
        }
        await tx.execute(
          "update message_quarantine set status = 'REDRIVING' where consumer_name = ? and message_id = ?",
          [consumer, message],
        );
        await this.event(
          tx,
          attempt.id,
          actor,
          existing ? 'RESUMED' : 'CLAIMED',
          justification.trim(),
        );
        return { attempt, publish: true };
      })
      .catch((error: unknown) => {
        if (error instanceof HttpException) throw error;
        throw new ServiceUnavailableException({ errorCode: 'REDRIVE_STORAGE_UNAVAILABLE' });
      });
    const attempt = claimed.attempt;
    if (!claimed.publish) {
      if (attempt.state === 'FAILED')
        throw new ServiceUnavailableException({
          errorCode: 'REDRIVE_SEND_FAILED',
          attemptId: attempt.id,
        });
      return { attemptId: attempt.id, state: attempt.state, replay: true };
    }
    let failure = false;
    try {
      await this.sqs.publishQuarantineCommand(
        attempt.payload,
        attempt.group_id,
        attempt.id,
        attempt.queue_url,
      );
    } catch {
      failure = true;
    }
    try {
      await db.transactional(async (tx) => {
        const rows = await tx.execute(
          `update quarantine_redrive_attempts set state = ?, error_code = ?, updated_at = clock_timestamp() where id = ? and state = 'PENDING' and lease_token = ? returning id`,
          [failure ? 'FAILED' : 'SENT', failure ? 'SQS_SEND_FAILED' : null, attempt.id, token],
        );
        if (!rows.length) throw new ConflictException({ errorCode: 'REDRIVE_LEASE_LOST' });
        await tx.execute(
          'update message_quarantine set status = ? where consumer_name = ? and message_id = ?',
          [failure ? 'OPEN' : 'RELEASED', consumer, message],
        );
        await this.event(
          tx,
          attempt.id,
          actor,
          failure ? 'FAILED' : 'PUBLISHED',
          justification.trim(),
        );
      });
    } catch {
      throw new ServiceUnavailableException({
        errorCode: 'REDRIVE_RESULT_UNKNOWN',
        attemptId: attempt.id,
      });
    }
    if (failure)
      throw new ServiceUnavailableException({
        errorCode: 'REDRIVE_SEND_FAILED',
        attemptId: attempt.id,
      });
    return { attemptId: attempt.id, state: 'SENT', replay: false };
  }
  private async event(
    tx: EntityManager,
    id: string,
    actor: Actor,
    event: string,
    justification: string,
  ) {
    await tx.execute(
      'insert into quarantine_operation_events (id,attempt_id,consumer_name,message_id,actor_issuer,actor_subject,event,justification) select ?,id,consumer_name,message_id,?,?,?,? from quarantine_redrive_attempts where id = ?',
      [randomUUID(), actor.issuer, actor.subject, event, justification, id],
    );
  }
}

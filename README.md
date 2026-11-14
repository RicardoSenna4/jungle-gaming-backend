# Jungle Distributed Wagering Processor

Implementação do desafio técnico Jungle Gaming. O enunciado original está preservado em [`CHALLENGE_SPEC.md`](./CHALLENGE_SPEC.md).

## Implementado

- Bun 1.1.38, NestJS, TypeScript estrito, MikroORM e PostgreSQL como única estratégia ORM/migration ativa.
- `Money` imutável com `decimal.js`, entrada/saída decimal em string, duas casas fixas e moeda explícita.
- Wallet com unicidade por jogador/moeda, saldo não negativo, lock pessimista por wallet, crédito `OPENING` e ledger append-only na mesma transação.
- BET, WIN, LOSS, REFUND e ROLLBACK com idempotência persistente, hash canônico, replay do snapshot original e validação das referências.
- Referências fora de ordem em `PENDING_REFERENCE`, retry com backoff/TTL e worker agendado.
- Consumer SQS FIFO com Inbox persistente, DLQ via redrive policy, reutilização do caso de uso financeiro, ack após commit e graceful shutdown.
- Outbox transacional e publisher SQS concorrente: reclamação em lotes com `FOR UPDATE SKIP LOCKED`, lease/token por claim, envio fora da transação, backoff exponencial e entrega at-least-once.
- Endpoints HTTP para wallets, ledger paginado, transações por ID/referência externa, submissão, reconciliação, health liveness/readiness e métricas Prometheus.
- Reconciliação em uma consulta consistente, com comparação saldo materializado versus créditos menos débitos; divergências são sinalizadas e nunca corrigidas automaticamente.
- Logs JSON de processamento sem payload monetário, contadores de negócio/filas/retries e gauges de backlog/outbox/DLQ.

A autenticação não foi implementada, como permitido pelo desafio; endpoints e canal de mensagem permanecem sem autenticação nesta entrega. Em produção, a identidade do provedor deve ser validada por um IdP OIDC externo.

## Executar localmente

Requisitos: Bun 1.1.38, Docker Compose, PostgreSQL 16 e LocalStack SQS.

```bash
cp .env.example .env
bun install --frozen-lockfile
docker compose up -d postgres localstack
bun run db:migrate
ENABLE_SQS_CONSUMER=true ENABLE_OUTBOX_PUBLISHER=true bun run start:bun
```

O consumer e o publisher são opt-in. O worker de referências pendentes inicia por padrão e pode ser desligado com `ENABLE_PENDING_REFERENCE_WORKER=false`. O publisher envia eventos à fila `wager-events.fifo`; não há exactly-once entre PostgreSQL e SQS. Cada envelope contém `eventId`, e consumidores downstream devem deduplicar.

## Endpoints principais

- `POST /wallets`, `GET /wallets/:walletId`
- `GET /wallets/:walletId/ledger?cursor=...&limit=50`
- `POST /wallets/:walletId/reconciliation`
- `POST /wagering/transactions` (requer `Idempotency-Key`)
- `GET /wagering/transactions/:transactionId`
- `GET /providers/:providerId/wagering/transactions/:externalTransactionId`
- `GET /health/live`, `GET /health/ready`
- `GET /metrics` (formato Prometheus; métricas por processo)

`/health/live` verifica apenas o processo. `/health/ready` retorna 503 se PostgreSQL ou as filas de comandos/eventos SQS não estiverem acessíveis.

## Qualidade e testes

```bash
bun run typecheck
bun run lint
bun run format:check
bun run build
bun run test:unit
bun run test:integration
bun run test:sqs:real
bun run db:migration:check
```

Validação desta revisão: **30 testes unitários aprovados; 25 testes PostgreSQL de integração aprovados; 1 teste LocalStack pulado**. Typecheck, lint, format check, build e `db:migration:check` também passaram; todas as quatro migrations foram aplicadas em PostgreSQL 16. O teste end-to-end com LocalStack não foi executado porque Docker/LocalStack não estão disponíveis neste sandbox; não é apresentado como aprovado.

## Migrations

As migrations MikroORM são versionadas e reversíveis em `src/infrastructure/database/migrations`. A migration `Migration20261114140000` adiciona token/índices de claim do publisher sem editar migrations já aplicadas. O código legado TypeORM foi removido para evitar duas fontes de schema e comandos concorrentes de migration.

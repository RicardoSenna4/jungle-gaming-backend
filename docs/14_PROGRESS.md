
## Tarefas 8 e 9 — REFUND/ROLLBACK, referências fora de ordem e consumer SQS — 2026-11-14

Foram implementados REFUND e ROLLBACK no mesmo caso de uso financeiro de HTTP/SQS. A resolução valida referência por provedor e transação externa, player, wallet, moeda, rodada, tipo e valor integral. A migration `Migration20261114130000` adiciona metadados de retry/TTL, índice de referências pendentes e unicidade parcial para impedir duas reversões diretas sobre a mesma referência.

Referências ausentes são persistidas como `PENDING_REFERENCE`; o `PendingReferenceWorker` reprocessa com backoff e expira com `REFERENCE_RETRY_EXHAUSTED`. Reversões processadas geram ledger imutável, outbox de processamento e `WalletBalanceChanged`; rejeições não movimentam saldo. O endpoint responde HTTP 202 para pending.

Foi implementado `WagerTransactionConsumer` para SQS FIFO, com validação do envelope/provider, Inbox única por consumer/message, reutilização exata do `WagerProcessingService`, ack após commit e redelivery segura. A fila FIFO, DLQ e redrive já estavam descritas no Compose/init script; foi adicionado teste end-to-end condicionado a LocalStack.

Evidências: 5 testes PostgreSQL de reversão e 3 testes PostgreSQL do consumer passaram, além de format/typecheck/lint. O gate LocalStack end-to-end ficou BLOCKED, não FAILED, porque Docker/LocalStack não estão disponíveis no sandbox (`docker: command not found`). Detalhes e comandos de reprodução estão em `docs/22_REVERSAL_SQS_EVIDENCE.md`.

Gate final posterior: build, migration check, format, typecheck, lint e `git diff --check` passaram; `RUN_INTEGRATION=1 bun test` terminou com 43 aprovados, 1 teste LocalStack pulado e 0 falhas.


## Continuação — publisher outbox, reconciliação e finalização — 2026-11-14

Foi implementado `OutboxPublisherWorker` para a fila `wager-events.fifo`: `FOR UPDATE SKIP LOCKED`, token/lease UUID para ownership do claim, publicação fora da transação, marcação após envio e backoff exponencial com teto de cinco minutos. A migration reversível `Migration20261114140000` adiciona `claim_token` e índices; o snapshot MikroORM foi atualizado. A entrega entre PostgreSQL e SQS é at-least-once, com deduplicação downstream por `eventId`.

Foi adicionada reconciliação SQL de saldo versus ledger sem autocorreção, endpoints de consulta de transação, health live/readiness com PostgreSQL e filas SQS, métricas Prometheus, logs estruturados sem valores monetários e graceful shutdown. O legado TypeORM inativo foi removido, mantendo MikroORM como fonte única de schema/migrations. Lockfiles Bun/npm foram sincronizados; AJV 8 explícito evita que o CLI resolva `ajv-draft-04` contra AJV 6.

Validação atual em PostgreSQL 16: **30 unit tests e 25 testes de integração aprovados**, incluindo concorrência real de dois publishers e reconciliação de uma divergência; **1 teste LocalStack foi pulado**. Typecheck, lint, format check, build e `db:migration:check` passaram. O teste FIFO end-to-end ainda requer Docker/LocalStack, indisponíveis neste sandbox. Reproduções e detalhes ficam em `docs/22_REVERSAL_SQS_EVIDENCE.md` e `ARCHITECTURE.md`.

Smoke HTTP após correção do bootstrap NestJS: `GET /health/live` retornou 200; readiness retornou 503 com `postgres=up` e `sqs=down` (LocalStack deliberadamente desligado); `/metrics` respondeu 200. Criação de wallet, BET de smoke, consulta por ID interno e consulta por `(providerId, externalTransactionId)` passaram contra PostgreSQL local.

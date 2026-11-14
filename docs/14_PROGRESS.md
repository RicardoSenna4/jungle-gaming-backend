
## Tarefas 8 e 9 — REFUND/ROLLBACK, referências fora de ordem e consumer SQS — 2026-11-14

Foram implementados REFUND e ROLLBACK no mesmo caso de uso financeiro de HTTP/SQS. A resolução valida referência por provedor e transação externa, player, wallet, moeda, rodada, tipo e valor integral. A migration `Migration20261114130000` adiciona metadados de retry/TTL, índice de referências pendentes e unicidade parcial para impedir duas reversões diretas sobre a mesma referência.

Referências ausentes são persistidas como `PENDING_REFERENCE`; o `PendingReferenceWorker` reprocessa com backoff e expira com `REFERENCE_RETRY_EXHAUSTED`. Reversões processadas geram ledger imutável, outbox de processamento e `WalletBalanceChanged`; rejeições não movimentam saldo. O endpoint responde HTTP 202 para pending.

Foi implementado `WagerTransactionConsumer` para SQS FIFO, com validação do envelope/provider, Inbox única por consumer/message, reutilização exata do `WagerProcessingService`, ack após commit e redelivery segura. A fila FIFO, DLQ e redrive já estavam descritas no Compose/init script; foi adicionado teste end-to-end condicionado a LocalStack.

Evidências: 5 testes PostgreSQL de reversão e 3 testes PostgreSQL do consumer passaram, além de format/typecheck/lint. O gate LocalStack end-to-end ficou BLOCKED, não FAILED, porque Docker/LocalStack não estão disponíveis no sandbox (`docker: command not found`). Detalhes e comandos de reprodução estão em `docs/22_REVERSAL_SQS_EVIDENCE.md`.

Gate final posterior: build, migration check, format, typecheck, lint e `git diff --check` passaram; `RUN_INTEGRATION=1 bun test` terminou com 43 aprovados, 1 teste LocalStack pulado e 0 falhas.

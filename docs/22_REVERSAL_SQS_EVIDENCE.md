# Evidências — Tarefas 8 e 9

## Reversões

O caso de uso central passou a aceitar `REFUND` e `ROLLBACK`. A resolução procura a referência por `(providerId, referenceExternalTransactionId)`, valida player, wallet, moeda, rodada, tipo permitido e valor integral. Uma referência só pode receber uma reversão direta por meio do índice único parcial `wager_transactions_reference_unique_idx`; um rollback de uma refund continua possível porque referencia a transação de refund, não a BET original.

`REFUND` só reverte BET processada. `ROLLBACK` reverte BET, WIN ou REFUND processada e aplica a direção inversa do lançamento original. A tentativa de débito que deixaria a wallet negativa usa `REVERSAL_INSUFFICIENT_FUNDS`, separado de `INSUFFICIENT_FUNDS` de BET.

Quando a referência não existe, a transação é persistida como `PENDING_REFERENCE`, com `reference_attempts`, `reference_next_attempt_at` e `reference_expires_at`. `PendingReferenceWorker` executa reprocessamento periódico com backoff exponencial e limite de cinco tentativas/TTL de cinco minutos. A expiração cria rejeição e evento outbox sem alterar wallet ou ledger.

## Consumer SQS

`WagerTransactionConsumer` lê `wager-transactions.fifo`, valida envelope e allowlist opcional `ALLOWED_PROVIDER_IDS`, chama exatamente `WagerProcessingService.process` e só exclui a mensagem depois que a transação SQL retorna com sucesso. A Inbox é criada com unicidade `(consumer_name, message_id)` na mesma transação da operação financeira e da outbox. Rejeições de negócio persistidas são ackadas após o commit; erros de contrato, conflitos de idempotência, falhas transitórias e exceções não persistidas ficam disponíveis para redelivery e redrive para `wager-transactions-dlq.fifo`.

O `docker-compose.yml` e `infra/localstack/init-queues.sh` já configuram a fila FIFO, DLQ FIFO e redrive policy. O consumer não depende da deduplicação/ordenação do SQS para a correção financeira.

## Testes executados

Com PostgreSQL 16 local e migrations aplicadas:

- `RUN_INTEGRATION=1 bun test test/integration/reversal-processing.spec.ts`: **5 aprovados**.
- `RUN_INTEGRATION=1 bun test test/integration/sqs-consumer.spec.ts`: **3 aprovados**.
- O cenário de redelivery chama o consumer duas vezes com o mesmo `messageId`; o resultado possui uma Inbox, uma transação financeira, um lançamento de ledger e uma outbox financeira.
- `bun run format`, `bun run typecheck` e `bun run lint`: **aprovados**.
- Gate completo final com PostgreSQL: **43 testes aprovados, 1 teste LocalStack pulado, 0 falhas**; build, migration check e `git diff --check` também passaram.

O teste `test/integration/sqs-localstack.spec.ts` e o comando `bun run test:sqs:real` foram adicionados para execução end-to-end, mas não foram declarados como aprovados nesta sessão: `docker --version` e `docker compose version` retornaram `command not found`, e a porta LocalStack 4566 não estava disponível. Reprodução: instalar Docker Compose, executar `docker compose up -d postgres localstack`, `bun run db:migrate` e então `bun run test:sqs:real`.

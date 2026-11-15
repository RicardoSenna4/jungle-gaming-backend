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


## Continuação — outbox e reconciliação (2026-11-14)

Publisher outbox validado contra PostgreSQL 16 real:

- `test/integration/outbox-publisher.spec.ts`: 3 testes aprovados — envio e marcação pós-publicação; somente um de dois publishers concorrentes reclama a mesma linha; falha libera lease e agenda retry.
- `test/integration/wallet-persistence.spec.ts`: cenário adicional aprovado — detecta divergência entre saldo persistido e soma do ledger, retorna diferença exata e mantém o saldo original sem autocorreção.
- `bun run db:migrate`: quatro migrations aplicadas, incluindo `Migration20261114140000`; `bun run db:migration:check`: nenhuma migration pendente.
- Validação corrente completa: 30 testes unitários aprovados, 25 integrações PostgreSQL aprovadas, 1 teste LocalStack pulado, 0 falhas. Typecheck, lint, build e format check aprovados.

Durante a primeira execução dos novos testes, o SQL usava placeholders `$1` diretamente em `Connection.execute`; o MikroORM exige `?` posicionais. Os bindings foram corrigidos e os testes reais passaram. O teste end-to-end de SQS FIFO segue pendente porque não há Docker/LocalStack no sandbox; os resultados acima não o incluem.


## Auditoria final — 2026-11-15

Foram adicionados eventos concretos por meio de `src/domain/events/event-factory.ts`. O fluxo financeiro agora instancia as subclasses `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference` e `WalletBalanceChanged`, serializando o envelope versionado na Outbox.

OPENING positivo passou a persistir, no mesmo commit SQL da wallet, transação e ledger:

- `WagerTransactionProcessed`;
- `WalletBalanceChanged`;
- `balanceBefore = 0.00`;
- `balanceAfter` igual ao crédito inicial;
- `walletVersion = 1`.

Foi criado `test/integration/http-api.spec.ts`, que sobe o NestJS contra PostgreSQL e verifica DTOs, HTTP 400 para contrato inválido, criação e consulta de wallet, ledger, BET, replay idempotente, consulta por ID, consulta por provider/external ID, reconciliação, liveness, readiness e métricas.

Foi corrigida a paginação do ledger para utilizar placeholders compatíveis com `Connection.execute` do MikroORM. O bug era observável como HTTP 500 em `GET /wallets/:walletId/ledger`.

O teste `test/integration/outbox-publisher.spec.ts` agora inclui recuperação após uma falha equivalente a crash entre envio e gravação de `published_at`: a primeira tentativa falha depois do envio, o lease é liberado, a segunda tentativa publica/marca o evento e `attempts` permanece rastreável.

Evidências executadas nesta etapa:

- wallet persistence e OPENING: **6 aprovados**;
- outbox publisher, incluindo crash-equivalent: **4 aprovados**;
- HTTP API real: **2 aprovados**;
- format, typecheck e lint: **aprovados**;
- Docker/LocalStack local: **bloqueado**, pois `docker` não está instalado e `localhost:4566` está indisponível.

O workflow `.github/workflows/ci.yml` foi alterado para executar `RUN_INTEGRATION=1 RUN_SQS_REAL=1 bun test test/integration/sqs-localstack.spec.ts` após subir PostgreSQL e LocalStack. A aprovação final do SQS end-to-end deve ser lida no workflow gerado por este commit.

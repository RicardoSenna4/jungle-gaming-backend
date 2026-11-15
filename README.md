# Jungle Distributed Wagering Processor

Implementação do desafio técnico Jungle Gaming. O enunciado original está preservado em [`CHALLENGE_SPEC.md`](./CHALLENGE_SPEC.md).

## Implementado

- Bun 1.1.38, NestJS, TypeScript estrito, MikroORM e PostgreSQL como única estratégia ORM/migration ativa.
- `Money` imutável com `decimal.js`, entrada/saída decimal em string, duas casas fixas e moeda explícita.
- Wallet com unicidade por jogador/moeda, saldo não negativo, lock pessimista por wallet, crédito `OPENING` e ledger append-only na mesma transação.
- OPENING positivo também grava `WagerTransactionProcessed` e `WalletBalanceChanged` na Outbox, com saldo anterior, saldo posterior e versão da wallet.
- BET, WIN, LOSS, REFUND e ROLLBACK com idempotência persistente, hash canônico, replay do snapshot original e validação das referências.
- Referências fora de ordem em `PENDING_REFERENCE`, retry com backoff/TTL e worker agendado.
- Consumer SQS FIFO com Inbox persistente, DLQ via redrive policy, reutilização do caso de uso financeiro, ack após commit e graceful shutdown.
- Outbox transacional e publisher SQS concorrente: reclamação em lotes com `FOR UPDATE SKIP LOCKED`, lease/token por claim, envio fora da transação, backoff exponencial e entrega at-least-once.
- Endpoints HTTP para wallets, ledger paginado, transações por ID/referência externa, submissão, reconciliação, health liveness/readiness e métricas Prometheus.
- Reconciliação em uma consulta consistente, com comparação saldo materializado versus créditos menos débitos; divergências são sinalizadas e nunca corrigidas automaticamente.
- Logs JSON de processamento sem payload monetário, contadores de negócio/filas/retries e gauges de backlog/outbox/DLQ.
- Eventos de integração são instanciados por subclasses concretas e serializados com versão; DTOs HTTP validam campos, moeda, escala decimal e tipos de operação.

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

`test:unit` não exige serviços externos. Os demais testes de integração precisam do PostgreSQL e/ou LocalStack iniciados; o executor configura as flags de integração, grava JUnit/logs em `.test-results/` e falha caso qualquer teste obrigatório seja pulado ou nenhuma execução seja reportada. O inventário de specs é descoberto recursivamente e comparado ao registro explícito; arquivos ausentes, não registrados ou duplicados bloqueiam o gate.

```bash
bun run typecheck
bun run lint
bun run format:check
bun run build
bun run test:unit
bun run test:integration:postgres
bun run test:integration:sqs
bun run test:concurrency
bun run test:recovery
bun run test:all
bun run db:migration:check
```

`bun run test` é um alias de `bun run test:all`. O workflow do GitHub Actions inicia PostgreSQL e LocalStack no runner descartável, aguarda as três filas, aplica migrations, executa a suíte completa serialmente entre arquivos, reverte cada migration e reaplica a cadeia. O paralelismo dentro dos cenários de concorrência continua ativo. Os resultados JUnit e logs são publicados como artefato do workflow.

No snapshot-base `688ba47`, a execução Actions do comando genérico reportou 30 pass e 29 skip; por isso, os relatos locais anteriores não são tratados como aprovação da suíte no CI desse SHA. Nesta branch, a execução completa do workflow ainda deve ser confirmada antes de declarar o gate aprovado. O sandbox de desenvolvimento não tem Docker (`docker: command not found`), então PostgreSQL/LocalStack reais serão validados pelo runner GitHub, não por mocks locais.

## Migrations

As migrations MikroORM são versionadas e reversíveis em `src/infrastructure/database/migrations`. A migration `Migration20261114140000` adiciona token/índices de claim do publisher sem editar migrations já aplicadas. O código legado TypeORM foi removido para evitar duas fontes de schema e comandos concorrentes de migration.

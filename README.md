# Jungle Distributed Wagering Processor

Implementação do desafio técnico da Jungle Gaming. O enunciado original foi preservado em [`CHALLENGE_SPEC.md`](./CHALLENGE_SPEC.md).

## O que está implementado

- NestJS com TypeScript estrito, TypeORM legado para wagering e MikroORM para a persistência de wallets.
- `Money` imutável, decimal exato, strings com duas casas e moeda explícita.
- Wallet com versão, saldo não negativo e concorrência protegida por `SELECT ... FOR UPDATE`.
- Criação de wallet com `OPENING` e ledger atômicos.
- BET, WIN, LOSS, REFUND e ROLLBACK com validação de contexto e valor integral.
- Caso de uso central de processamento para BET, WIN, LOSS, REFUND e ROLLBACK, reutilizável por HTTP/SQS.
- Idempotência persistente por provedor/chave, hash SHA-256 de JSON canônico e replay do snapshot original.
- PostgreSQL com constraints de unicidade, `CHECK(balance >= 0)`, ledger append-only via trigger e outbox transacional.
- Referências fora de ordem persistidas como `PENDING_REFERENCE`, com backoff, TTL, expiração estável e worker agendado.
- Consumer SQS FIFO com validação de envelope/provider, Inbox única por `(consumerName, messageId)`, ack somente após commit e DLQ via redrive policy.
- Endpoints `POST /wallets`, `GET /wallets/:walletId`, `GET /wallets/:walletId/ledger`, `POST /wagering/transactions`, `/health/live` e `/health/ready`.

## Executar a fundação

O runtime oficial é Bun 1.x. A configuração fixa `bun@1.1.38` em `package.json`, `bunfig.toml` e `bun.lockb`. Também é necessário PostgreSQL 16 e Docker Compose para os serviços locais.

```bash
cp .env.example .env
bun install --frozen-lockfile
docker compose up -d postgres localstack
bun run db:migrate
bun run build
bun test
bun run start:bun
```

A migration de bootstrap reversível está em `src/infrastructure/database/migrations/Migration20261113140000.ts`. O schema financeiro completo, com wallets, transações, ledger, inbox, outbox, índices, constraints e trigger append-only, está em `src/infrastructure/database/migrations/Migration20261113150000.ts`. O Compose cria PostgreSQL, LocalStack SQS, `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wager-events.fifo`.

Comandos de qualidade: `bun run typecheck`, `bun run lint`, `bun run format:check`, `bun run build`, `bun test`, `bun run test:integration`, `bun run test:sqs:real`, `bun run db:migration:check` e `bun run db:rollback`. Os testes de integração exigem PostgreSQL ativo; `test:sqs:real` exige PostgreSQL e LocalStack ativos.

## Contrato de idempotência

`Idempotency-Key` é obrigatório no submit. O hash usa SHA-256 do objeto de negócio com chaves ordenadas; o header não entra no hash. Repetição da mesma chave e payload retorna o snapshot original com `idempotentReplay: true`. Reuso com payload diferente retorna conflito.

## Limitações conhecidas

A execução end-to-end contra LocalStack depende de Docker disponível no ambiente. Nesta sessão o código, os testes PostgreSQL reais e os testes do consumer foram executados, mas o gate `test:sqs:real` não pôde ser executado porque o binário Docker não está instalado. O publisher/reconciliador da outbox permanece fora desta tarefa. Ver [`ARCHITECTURE.md`](./ARCHITECTURE.md).

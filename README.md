# Distributed Wagering Processor

**Backend Challenge — Jungle Gaming**  
Processamento distribuído de operações de apostas com saldo consistente, ledger auditável e entrega confiável de eventos.

[![CI — main](https://github.com/RicardoSenna4/jungle-gaming-backend/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/RicardoSenna4/jungle-gaming-backend/actions/workflows/ci.yml)
[![Bun 1.x](https://img.shields.io/badge/runtime-Bun%201.x-333333)](package.json)
[![PostgreSQL 16](https://img.shields.io/badge/database-PostgreSQL%2016-316192)](docker-compose.yml)

[**Executar**](#execução-rápida) · [**Arquitetura**](#arquitetura) · [**Requisitos**](#matriz-de-avaliação) · [**Testes críticos**](#testes-críticos) · [**API**](docs/API.md) · [**Guia de uso**](docs/DEMO.md) · [**Limitações**](#decisões-e-limitações)

## Objetivo e estado

Esta solução recebe `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK` por HTTP ou SQS FIFO. Trata concorrência, reenvios, referências fora de ordem e falhas de infraestrutura usando PostgreSQL como fonte da verdade.

**Stack:** Bun 1.1.38, TypeScript strict, NestJS, MikroORM, PostgreSQL 16, AWS SQS via LocalStack e Docker Compose. O [enunciado original](CHALLENGE_SPEC.md) foi preservado.

**Estado da versão entregue:** consulte o [executar o CI da `main`](https://github.com/RicardoSenna4/jungle-gaming-backend/actions/workflows/ci.yml?query=branch%3Amain) e confira se o SHA da execução aprovada coincide com o [último commit da branch](https://github.com/RicardoSenna4/jungle-gaming-backend/commits/main). **Evidência histórica verificada:** a [execução #43770950239](https://github.com/RicardoSenna4/jungle-gaming-backend/actions/runs/43770950239), no commit [`3e540c6`](https://github.com/RicardoSenna4/jungle-gaming-backend/commit/3e540c6da0b7197ae1954c4315febd198a292b64), registrou **80 testes aprovados, zero falhas, zero ignorados** e smoke em container com SIGKILL/SIGTERM. Ela é um **snapshot histórico**, não afirmação de que futuros commits estejam aprovados. Consulte o [guia de evidências de CI](docs/CI_EVIDENCE.md).

## Execução rápida

Requer Docker Engine + Docker Compose v2 e portas 3000, 5432 e 4566 livres.

**Primeira vez?** Siga o [guia de execução e validação passo a passo](docs/DEMO.md), com orientações para **PowerShell (Windows), WSL/Ubuntu, Git Bash, Linux e macOS**. O Docker executa a API e as dependências; Bun e PostgreSQL não precisam ser instalados no host.

~~~bash
git clone https://github.com/RicardoSenna4/jungle-gaming-backend.git
cd jungle-gaming-backend
docker compose up --build -d
docker compose ps
curl http://localhost:3000/health/live
curl http://localhost:3000/health/ready
~~~

O serviço `api` aplica as migrations ao iniciar; PostgreSQL e LocalStack têm health checks. Credenciais do Compose são **somente de desenvolvimento**. Para encerrar sem apagar volumes: `docker compose down`. Não use `down -v` se quiser preservar dados.

Alternativamente, rode a API com Bun no host e apenas Postgres/LocalStack no Compose; veja [guia de testes](docs/TESTING.md) e [.env.example](.env.example).

## Arquitetura

~~~mermaid
flowchart LR
  HTTP["HTTP / NestJS"] --> UC["WagerProcessingService"]
  Q["SQS FIFO · comandos"] --> IN["Consumer + Inbox"]
  IN --> UC
  P["Worker PENDING_REFERENCE"] --> UC
  UC --> DB[("PostgreSQL: Wallet + Transaction + Ledger + Inbox + Outbox")]
  DB --> PUB["Outbox Publisher"]
  PUB --> E["SQS FIFO · eventos"]
~~~

**Garantias centrais:** `Money` usa decimal exato em strings; o saldo é protegido por lock `SELECT FOR UPDATE` por wallet; constraints e trigger protegem o ledger. Idempotência é persistente com hash canônico SHA-256 e snapshot da resposta. Inbox confirma somente após commit; Outbox publica **depois** do commit. A entrega é **at-least-once** (o consumidor deve deduplicar eventos por `eventId`), não exactly-once.

[Arquitetura completa](ARCHITECTURE.md) · [Decisões/ADRs](docs/02_ADR_REGISTER.md) · [Recuperação de falhas](docs/FAILURE_RECOVERY.md)

## Matriz de avaliação

A tabela utiliza **pesos oficiais**, não uma pontuação atribuída ao projeto. Cada evidência aponta para código ou teste real. A [rastreabilidade detalhada](docs/REQUIREMENTS_TRACEABILITY.md) relaciona 34 requisitos.

| Critério | Peso | Implementação | Teste/evidência |
|---|---:|---|---|
| Correção financeira | 20 | [Money](src/domain/money.ts), [wallet/ledger](src/application/wallets/wallet-repository.ts) | [Wagering](test/integration/wager-processing.spec.ts), [schema](test/integration/schema-contracts.spec.ts) |
| Concorrência | 20 | [Transações e locks](src/application/wager-processing.service.ts) | [4 cenários multiprocessos](test/integration/concurrency.spec.ts) |
| Idempotência | 15 | [Hash canônico](src/application/canonical-hash.ts), [processador](src/application/wager-processing.service.ts) | [50 replays](test/integration/concurrency.spec.ts) |
| Mensageria e falhas | 15 | [Consumer + Inbox](src/infrastructure/workers/wager-transaction.consumer.ts), [Outbox](src/infrastructure/workers/outbox-publisher.worker.ts) | [LocalStack real](test/integration/sqs-localstack.spec.ts), [smoke](scripts/smoke-compose.ts) |
| Arquitetura | 10 | [ARCHITECTURE](ARCHITECTURE.md), [ADRs](docs/02_ADR_REGISTER.md) | [Domínio](test/unit/domain-entities.spec.ts) |
| Testes | 10 | [Runner](scripts/test-suite-runner.ts), [CI](.github/workflows/ci.yml) | [Relatório e instruções](docs/TESTING.md) |
| Observabilidade | 5 | [Métricas](src/infrastructure/telemetry/metrics.service.ts), [health](src/infrastructure/telemetry/health.service.ts) | [HTTP real](test/integration/http-api.spec.ts) |
| Documentação | 5 | [API](docs/API.md), [arquitetura](ARCHITECTURE.md) | [Requisitos](docs/REQUIREMENTS_TRACEABILITY.md), [guia de uso](docs/DEMO.md) |

## Testes críticos

| Cenário | Resultado esperado, validado pelo CI citado | Teste |
|---|---|---|
| 100.00 + duas BETs de 80.00 | 1 `PROCESSED`, 1 `REJECTED`, saldo 20.00, um débito | [Concorrência A](test/integration/concurrency.spec.ts) |
| 50 envios simultâneos idênticos | Um efeito financeiro e 49 replays | [Concorrência B](test/integration/concurrency.spec.ts) |
| Três processos independentes | Sem lost update e com ledger consistente | [Concorrência D](test/integration/concurrency.spec.ts) |
| Reversão fora de ordem | `PENDING_REFERENCE` resolvida pelo worker agendado | [Pending Worker](test/integration/pending-worker.spec.ts) |
| Reentrega/DLQ SQS | Sem novo débito e redrive de mensagem inválida | [LocalStack E2E](test/integration/sqs-localstack.spec.ts) |
| SIGKILL/SIGTERM e reinício | Saldo, ledger e replay preservados | [Smoke Compose](scripts/smoke-compose.ts) |

**Limite da prova:** o smoke encerra a API real, mas não induz necessariamente uma falha no exato instante pós-envio/pré-marcação da Outbox ou durante um ACK. Consulte [checklist](docs/DELIVERY_CHECKLIST.md).

## API HTTP

| Método | Rota | Finalidade |
|---|---|---|
| `POST` | `/wallets` | Criação e crédito `OPENING` |
| `GET` | `/wallets/:walletId` | Saldo e versão |
| `GET` | `/wallets/:walletId/ledger` | Ledger paginado |
| `POST` | `/wagering/transactions` | Envio com `Idempotency-Key` |
| `GET` | `/wagering/transactions/:transactionId` | Consulta interna |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta externa |
| `POST` | `/wallets/:walletId/reconciliation` | Reconciliação |
| `GET` | `/health/live`, `/health/ready`, `/metrics` | Saúde e observabilidade |

[Contratos, payloads e códigos HTTP](docs/API.md) · [Passo a passo para executar e usar](docs/DEMO.md)

## Testes e CI

~~~bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run format:check
bun run build
# Com Postgres, LocalStack e migrations aplicadas em banco isolado:
bun run test:all
~~~

O CI executa todos os testes necessários com PostgreSQL e LocalStack reais. O runner falha se houver testes obrigatórios ignorados ou targets sem testes. [Instruções e evidências](docs/TESTING.md).

## Decisões e limitações

- **Monólito modular:** evita transações distribuídas adicionais.
- **Lock por wallet:** reduz concorrência sobre saldo compartilhado, sem lock global.
- **Auth:** não implementada, conforme escopo permitido. O [guard](src/interfaces/http/provider-identity.guard.ts) é um ponto de extensão **no-op**; não fornece segurança real.
- **Ambiente:** LocalStack, sem validar AWS gerenciado, IdP, segredos ou observabilidade centralizada.
- **Entrega:** não prometer exactly-once nem robustez contra todos os modos de falha; a homologação humana e a submissão permanecem pendentes.

[Limitações](docs/OPEN_ISSUES.md) · [Checklist de entrega](docs/DELIVERY_CHECKLIST.md)

## Documentação

[Arquitetura](ARCHITECTURE.md) · [Rastreabilidade](docs/REQUIREMENTS_TRACEABILITY.md) · [API](docs/API.md) · [Como executar e usar](docs/DEMO.md) · [Evidência de CI](docs/CI_EVIDENCE.md) · [Testes](docs/TESTING.md) · [Falhas](docs/FAILURE_RECOVERY.md) · [ADRs](docs/02_ADR_REGISTER.md) · [Índice de ADRs](docs/adr/README.md) · [Auditoria](docs/FINAL_DELIVERY_AUDIT.md) · [Enunciado](CHALLENGE_SPEC.md).

Os resultados vermelhos de commits intermediários permanecem no histórico; a entrega é demonstrada pelo **CI verde associado ao SHA submetido**, sem reescrever a história do projeto.

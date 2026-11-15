# Rastreamento do desafio — implementação e evidências

**Referência normativa:** [CHALLENGE_SPEC.md](../CHALLENGE_SPEC.md), confrontado com o [enunciado original](https://github.com/junglegaming/backend-challenge).

**Baseline:** [docs/EVIDENCE_BASELINE.md](EVIDENCE_BASELINE.md) (commit `688ba47`, quando 29 testes ainda eram ignorados). Este documento descreve o estado **depois** das correções.

**Commit de código auditado:** [`09acbd3`](https://github.com/RicardoSenna4/jungle-gaming-backend/commit/09acbd3be159acd482cd88e9814a105f8e29a45d).

**Execução reproduzível:** [GitHub Actions #43763470242](https://github.com/RicardoSenna4/jungle-gaming-backend/actions/runs/43763470242), na `main`, em 15/11/2026: **80 testes aprovados, 0 falhas, 0 erros e 0 ignorados**, em 12 targets. `typecheck`, lint, Prettier, build, Docker image, Compose config, migration up/down/reapply e SQS LocalStack passaram. Também passou o smoke de boot e reinicialização real da API em Compose (SIGKILL/SIGTERM), com persistência e replay idempotente.

> PASS significa que existe evidência de implementação e teste adequada ao item indicado, **não** garantia absoluta contra falhas de produção. PASS parcial indica que parte do comportamento continua dependente de smoke test real pelo proprietário. O status humano de entrega está documentado em [DELIVERY_CHECKLIST.md](DELIVERY_CHECKLIST.md).

| ID | Requisito | Código e configuração | Prova automatizada | Status |
|---|---|---|---|---|
| R01 | Stack Bun, TypeScript strict, NestJS, MikroORM, PostgreSQL, SQS, Compose | package.json; Dockerfile; docker-compose.yml | CI build + container + LocalStack | PASS |
| R02 | Migrations versionadas e reversíveis | src/infrastructure/database/migrations/ | CI migration:up / pending / down chain / up | PASS |
| R03 | Money decimal exato e limites | src/domain/money.ts | test/unit/money.spec.ts; test/integration/schema-contracts.spec.ts | PASS |
| R04 | Factories, rehydrate e domínio separado | src/domain/; src/application/wager-processing.service.ts | test/unit/domain-entities.spec.ts; integration | PASS (módulos integrados) |
| R05 | Wallet por jogador e moeda, versionamento | src/application/wallets/wallet-repository.ts | test/integration/wallet-persistence.spec.ts | PASS |
| R06 | Saldo não negativo e lock distribuído | src/application/wager-processing.service.ts; migrations | test/integration/concurrency.spec.ts | PASS |
| R07 | OPENING e ledger no mesmo commit | src/application/wallets/wallet-repository.ts | test/integration/wallet-persistence.spec.ts | PASS |
| R08 | BET debita e rejeita insuficiência | src/application/wager-processing.service.ts | test/integration/wager-processing.spec.ts | PASS |
| R09 | WIN credita e LOSS não movimenta | src/application/wager-processing.service.ts | test/integration/wager-processing.spec.ts | PASS |
| R10 | REFUND reverte BET integral e uma vez | src/application/wager-processing.service.ts | test/integration/reversal-processing.spec.ts | PASS |
| R11 | ROLLBACK de BET/WIN/REFUND | src/application/wager-processing.service.ts | test/integration/reversal-processing.spec.ts | PASS |
| R12 | Referência/contexto de provider, round, wallet, moeda | src/application/wager-processing.service.ts | test/integration/reversal-processing.spec.ts | PASS |
| R13 | PENDING_REFERENCE, timer e TTL | src/infrastructure/workers/pending-reference.worker.ts | test/integration/pending-worker.spec.ts; reversal-processing | PASS (restart real não ensaiado) |
| R14 | Estados terminais e transições | src/domain/wager-transaction.ts; wager-processing.service.ts | test/unit/domain-entities.spec.ts; reversal-processing | PASS |
| R15 | Ledger append-only, checks e aritmética | src/infrastructure/database/migrations/ | test/integration/wallet-persistence.spec.ts; schema-contracts | PASS |
| R16 | Reconciliação sem autocorreção | src/application/wallets/wallet-repository.ts | test/unit/wallet-reconciliation.spec.ts; http-api | PASS |
| R17 | Idempotency-Key e replay original | src/application/wager-processing.service.ts | test/integration/concurrency.spec.ts; wager-processing | PASS |
| R18 | Hash canônico e conflito por payload | src/application/canonical-hash.ts | test/unit/canonical-hash.spec.ts; wager-processing | PASS |
| R19 | Rotas HTTP, validação, consultas e cursor | src/interfaces/http/; wallet-repository.ts | test/integration/http-api.spec.ts; ledger-pagination | PASS |
| R20 | SQS FIFO, Inbox e caso de uso comum | src/infrastructure/workers/wager-transaction.consumer.ts | test/integration/sqs-consumer.spec.ts; sqs-localstack | PASS |
| R21 | ACK pós-commit, retry, DLQ, shutdown | wager-transaction.consumer.ts; infra/localstack/init-queues.sh | test/integration/sqs-localstack.spec.ts | PASS parcial (SIGTERM real requer smoke) |
| R22 | Inbox, ledger, wallet e outbox em commit SQL | src/application/wager-processing.service.ts | test/integration/sqs-consumer.spec.ts; wallet-persistence | PASS |
| R23 | Outbox pós-commit, concorrência e retries | outbox-publisher.worker.ts | test/integration/outbox-publisher.spec.ts; sqs-localstack | PASS parcial (kill -9 real requer smoke) |
| R24 | Eventos concretos e envelope versionado | src/domain/events/ | test/unit/events.spec.ts; sqs-localstack | PASS |
| R25 | BET 80+80 / saldo 100 | src/application/wager-processing.service.ts | test/integration/concurrency.spec.ts A | PASS |
| R26 | 50 replays / ≥3 processos / wallets paralelas | src/application/wager-processing.service.ts | test/integration/concurrency.spec.ts B-D | PASS |
| R27 | Recovery/out-of-order/leases/restart | src/infrastructure/workers/ | pending-worker; sqs-localstack; outbox-publisher | PARCIAL (reinício real e falha de rede não testados integralmente) |
| R28 | Logs JSON, redaction e métricas | src/infrastructure/telemetry/ | test/unit/json-logger.spec.ts; metrics.service; http-api | PASS |
| R29 | Liveness e readiness PostgreSQL/SQS | src/infrastructure/telemetry/health.service.ts | test/unit/health.service.spec.ts; http-api | PASS |
| R30 | Documentação e instalação limpa | README.md; ARCHITECTURE.md; Dockerfile; docs/ | CI: build + Compose + test:all + smoke:compose | PASS CI / instalação em máquina do proprietário pendente |
| R31 | Auth opcional com extensão explícita | src/interfaces/http/provider-identity.guard.ts | test/unit/provider-identity.guard.spec.ts | PASS (guard no-op documentado) |
| R32 | Testes reais, sem mock substituto | test/integration/; .github/workflows/ci.yml | CI 80 PASS, 0 FAIL, 0 SKIP | PASS |
| R33 | Lock por wallet e ORM permitido | src/application/wager-processing.service.ts; MikroORM | test/integration/concurrency.spec.ts | PASS |
| R34 | FailureCode estável, HTTP 400/409/422/202/503 | src/interfaces/http/; src/domain/failure-code.ts | test/integration/http-api.spec.ts | PASS |

## Como auditar

1. Execute `bun run test:all` em ambiente com PostgreSQL e LocalStack disponíveis ou abra a execução de CI acima.
2. Veja `scripts/test-suite-runner.ts` para a lista exata de specs executadas. O runner rejeita testes ignorados, arquivos novos não registrados e alvos com zero testes.
3. Consulte [TESTING.md](TESTING.md), [FAILURE_RECOVERY.md](FAILURE_RECOVERY.md) e [ARCHITECTURE.md](../ARCHITECTURE.md) para premissas, cenários de falha e limites.
4. **Não** interprete uma simulação de crash como um teste real de `SIGKILL` seguido de restart. Esse tipo de demonstração operacional está descrito no roteiro humano.

## Limites a declarar

- Autenticação OIDC/JWT real não foi implementada; existe um guard de extensão permissivo (o enunciado permite não implementar autenticação).
- Nenhum banco/filas de produção foi usado. O teste distribuído é executado em PostgreSQL/LocalStack efêmeros.
- Os testes de recuperação incluem reentrega real pelo LocalStack, reinicialização da API por SIGKILL/SIGTERM e falha simulada de publish; não provam falhas de rede ou o instante exato pós-publicação/pré-marcação em todas as situações.
- A verificação manual de instalação limpa e a liberação de acesso à banca continuam pendentes do proprietário.

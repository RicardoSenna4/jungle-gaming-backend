# Rastreabilidade — 34 requisitos, código e teste

**Especificação soberana:** [CHALLENGE_SPEC.md](../CHALLENGE_SPEC.md) e [repositório oficial](https://github.com/junglegaming/backend-challenge). Os IDs R01–R34 são identificadores internos de auditoria, **não IDs do enunciado**.

**Evidência de execução (snapshot histórico):** [CI #43770950239](https://github.com/RicardoSenna4/jungle-gaming-backend/actions/runs/43770950239), commit [`3e540c6`](https://github.com/RicardoSenna4/jungle-gaming-backend/commit/3e540c6da0b7197ae1954c4315febd198a292b64): **80 testes, zero falhas, zero erros, zero skips**, 12 alvos, PostgreSQL, LocalStack, migrations e smoke do container com SIGKILL/SIGTERM. **Não use esse registro para afirmar aprovação de commits futuros.** Para o estado atual da `main`, confira [CI_EVIDENCE.md](CI_EVIDENCE.md) e valide que o SHA da última execução aprovada é o SHA submetido.

**Como usar:** clique em código e teste na mesma linha. `PASS no CI` significa que as verificações citadas foram executadas no ambiente descartável; não é um certificado de produção. `PARCIAL` indica cenário adicional de falha ainda não induzido exatamente no instante crítico.

| ID | Requisito | Implementação | Teste / prova | Resultado |
|---|---|---|---|---|
| **R01** | Stack Bun, TypeScript strict, NestJS, MikroORM, PostgreSQL, SQS, Compose | [package.json](../package.json) · [Dockerfile](../Dockerfile) · [docker-compose.yml](../docker-compose.yml) | [ci.yml](../.github/workflows/ci.yml) | **PASS no CI** |
| **R02** | Migrations versionadas e reversíveis | [Migration20261113150000.ts](../src/infrastructure/database/migrations/Migration20261113150000.ts) · [Migration20261114130000.ts](../src/infrastructure/database/migrations/Migration20261114130000.ts) | [schema-contracts.spec.ts](../test/integration/schema-contracts.spec.ts) | **PASS no CI** |
| **R03** | Money decimal exato e limites | [money.ts](../src/domain/money.ts) | [money.spec.ts](../test/unit/money.spec.ts) · [schema-contracts.spec.ts](../test/integration/schema-contracts.spec.ts) | **PASS no CI** |
| **R04** | Factories, rehydrate e domínio separado | [wallet.ts](../src/domain/wallet.ts) · [wager-transaction.ts](../src/domain/wager-transaction.ts) | [domain-entities.spec.ts](../test/unit/domain-entities.spec.ts) | **PASS no CI** |
| **R05** | Wallet por jogador e moeda, versionamento | [wallet-repository.ts](../src/application/wallets/wallet-repository.ts) | [wallet-persistence.spec.ts](../test/integration/wallet-persistence.spec.ts) | **PASS no CI** |
| **R06** | Saldo não negativo e lock distribuído | [wager-processing.service.ts](../src/application/wager-processing.service.ts) | [concurrency.spec.ts](../test/integration/concurrency.spec.ts) | **PASS no CI** |
| **R07** | OPENING e ledger no mesmo commit | [wallet-repository.ts](../src/application/wallets/wallet-repository.ts) | [wallet-persistence.spec.ts](../test/integration/wallet-persistence.spec.ts) | **PASS no CI** |
| **R08** | BET debita e rejeita insuficiência | [wager-processing.service.ts](../src/application/wager-processing.service.ts) | [wager-processing.spec.ts](../test/integration/wager-processing.spec.ts) | **PASS no CI** |
| **R09** | WIN credita e LOSS não movimenta | [wager-processing.service.ts](../src/application/wager-processing.service.ts) | [wager-processing.spec.ts](../test/integration/wager-processing.spec.ts) | **PASS no CI** |
| **R10** | REFUND reverte BET integral e uma vez | [wager-processing.service.ts](../src/application/wager-processing.service.ts) | [reversal-processing.spec.ts](../test/integration/reversal-processing.spec.ts) | **PASS no CI** |
| **R11** | ROLLBACK de BET/WIN/REFUND | [wager-processing.service.ts](../src/application/wager-processing.service.ts) | [reversal-processing.spec.ts](../test/integration/reversal-processing.spec.ts) | **PASS no CI** |
| **R12** | Referência/contexto de provider, round, wallet, moeda | [wager-processing.service.ts](../src/application/wager-processing.service.ts) | [reversal-processing.spec.ts](../test/integration/reversal-processing.spec.ts) | **PASS no CI** |
| **R13** | PENDING_REFERENCE, timer e TTL | [pending-reference.worker.ts](../src/infrastructure/workers/pending-reference.worker.ts) | [pending-worker.spec.ts](../test/integration/pending-worker.spec.ts) · [reversal-processing.spec.ts](../test/integration/reversal-processing.spec.ts) | **PASS no CI** |
| **R14** | Estados terminais e transições | [wager-transaction.ts](../src/domain/wager-transaction.ts) | [domain-entities.spec.ts](../test/unit/domain-entities.spec.ts) | **PASS no CI** |
| **R15** | Ledger append-only, checks e aritmética | [Migration20261113150000.ts](../src/infrastructure/database/migrations/Migration20261113150000.ts) · [ledger.ts](../src/domain/ledger.ts) | [schema-contracts.spec.ts](../test/integration/schema-contracts.spec.ts) · [wallet-persistence.spec.ts](../test/integration/wallet-persistence.spec.ts) | **PASS no CI** |
| **R16** | Reconciliação sem autocorreção | [wallet-repository.ts](../src/application/wallets/wallet-repository.ts) | [wallet-persistence.spec.ts](../test/integration/wallet-persistence.spec.ts) · [http-api.spec.ts](../test/integration/http-api.spec.ts) | **PASS no CI** |
| **R17** | Idempotency-Key e replay original | [wager-processing.service.ts](../src/application/wager-processing.service.ts) | [concurrency.spec.ts](../test/integration/concurrency.spec.ts) · [wager-processing.spec.ts](../test/integration/wager-processing.spec.ts) | **PASS no CI** |
| **R18** | Hash canônico e conflito por payload | [canonical-hash.ts](../src/application/canonical-hash.ts) | [canonical-hash.spec.ts](../test/unit/canonical-hash.spec.ts) | **PASS no CI** |
| **R19** | Rotas HTTP, validação, consultas e cursor | [app.controller.ts](../src/interfaces/http/app.controller.ts) · [wallet.controller.ts](../src/interfaces/http/wallet.controller.ts) | [http-api.spec.ts](../test/integration/http-api.spec.ts) · [ledger-pagination.spec.ts](../test/integration/ledger-pagination.spec.ts) | **PASS no CI** |
| **R20** | SQS FIFO, Inbox e caso de uso comum | [wager-transaction.consumer.ts](../src/infrastructure/workers/wager-transaction.consumer.ts) | [sqs-consumer.spec.ts](../test/integration/sqs-consumer.spec.ts) · [sqs-localstack.spec.ts](../test/integration/sqs-localstack.spec.ts) | **PASS no CI** |
| **R21** | ACK pós-commit, retry, DLQ, shutdown | [wager-transaction.consumer.ts](../src/infrastructure/workers/wager-transaction.consumer.ts) · [init-queues.sh](../infra/localstack/init-queues.sh) | [sqs-localstack.spec.ts](../test/integration/sqs-localstack.spec.ts) · [smoke-compose.ts](../scripts/smoke-compose.ts) | **PARCIAL** |
| **R22** | Inbox, ledger, wallet e outbox em commit SQL | [wager-processing.service.ts](../src/application/wager-processing.service.ts) | [sqs-consumer.spec.ts](../test/integration/sqs-consumer.spec.ts) | **PASS no CI** |
| **R23** | Outbox pós-commit, concorrência e retries | [outbox-publisher.worker.ts](../src/infrastructure/workers/outbox-publisher.worker.ts) | [outbox-publisher.spec.ts](../test/integration/outbox-publisher.spec.ts) · [sqs-localstack.spec.ts](../test/integration/sqs-localstack.spec.ts) | **PARCIAL** |
| **R24** | Eventos concretos e envelope versionado | [wager-events.ts](../src/domain/events/wager-events.ts) · [wallet-balance-changed.ts](../src/domain/events/wallet-balance-changed.ts) | [events.spec.ts](../test/unit/events.spec.ts) | **PASS no CI** |
| **R25** | BET 80+80 / saldo 100 | [wager-processing.service.ts](../src/application/wager-processing.service.ts) | [concurrency.spec.ts](../test/integration/concurrency.spec.ts) | **PASS no CI** |
| **R26** | 50 replays / ≥3 processos / wallets paralelas | [wager-processing.service.ts](../src/application/wager-processing.service.ts) | [concurrency.spec.ts](../test/integration/concurrency.spec.ts) | **PASS no CI** |
| **R27** | Recovery/out-of-order/leases/restart | [pending-reference.worker.ts](../src/infrastructure/workers/pending-reference.worker.ts) · [outbox-publisher.worker.ts](../src/infrastructure/workers/outbox-publisher.worker.ts) | [pending-worker.spec.ts](../test/integration/pending-worker.spec.ts) · [outbox-publisher.spec.ts](../test/integration/outbox-publisher.spec.ts) · [smoke-compose.ts](../scripts/smoke-compose.ts) | **PARCIAL** |
| **R28** | Logs JSON, redaction e métricas | [json-logger.ts](../src/infrastructure/telemetry/json-logger.ts) · [metrics.service.ts](../src/infrastructure/telemetry/metrics.service.ts) | [json-logger.spec.ts](../test/unit/json-logger.spec.ts) · [metrics.service.spec.ts](../test/unit/metrics.service.spec.ts) | **PASS no CI** |
| **R29** | Liveness e readiness PostgreSQL/SQS | [health.service.ts](../src/infrastructure/telemetry/health.service.ts) | [http-api.spec.ts](../test/integration/http-api.spec.ts) · [health.service.spec.ts](../test/unit/health.service.spec.ts) | **PASS no CI** |
| **R30** | Documentação e instalação limpa | [README.md](../README.md) · [Dockerfile](../Dockerfile) · [docker-compose.yml](../docker-compose.yml) | [smoke-compose.ts](../scripts/smoke-compose.ts) · [ci.yml](../.github/workflows/ci.yml) | **PASS CI · homologação pendente** |
| **R31** | Auth opcional com extensão explícita | [provider-identity.guard.ts](../src/interfaces/http/provider-identity.guard.ts) | [provider-identity.guard.spec.ts](../test/unit/provider-identity.guard.spec.ts) | **PASS no CI** |
| **R32** | Testes reais, sem mock substituto | [test-suite-runner.ts](../scripts/test-suite-runner.ts) · [ci.yml](../.github/workflows/ci.yml) | [required-test-runner.spec.ts](../test/unit/required-test-runner.spec.ts) · [sqs-localstack.spec.ts](../test/integration/sqs-localstack.spec.ts) | **PASS no CI** |
| **R33** | Lock por wallet e ORM permitido | [wager-processing.service.ts](../src/application/wager-processing.service.ts) | [concurrency.spec.ts](../test/integration/concurrency.spec.ts) | **PASS no CI** |
| **R34** | FailureCode estável, HTTP 400/409/422/202/503 | [app.controller.ts](../src/interfaces/http/app.controller.ts) · [failure-code.ts](../src/domain/failure-code.ts) | [http-api.spec.ts](../test/integration/http-api.spec.ts) | **PASS no CI** |

## Limites de comprovação

- **SQS/Inbox:** testes reais de redelivery e DLQ passaram; o SIGTERM do container API foi verificado, porém não se injetou obrigatoriamente encerramento **durante o ACK** de mensagem em trânsito.
- **Outbox:** publicador concorrente e publicação real verificados; o cenário exato de queda **após `SendMessage` e antes do `publishedAt`** segue exercitado por falha simulada, não SIGKILL disparado naquele instante.
- **Persistência/restart:** smoke com SIGKILL e SIGTERM em container real comprovado; teste em AWS gerenciado não faz parte deste ambiente.
- **Entrega humana:** instalação na máquina do proprietário, decisão de visibilidade/permissão do repositório, regras de submissão e envio ao recrutador dependem do usuário.

## Navegação

[README para avaliação](../README.md) · [arquitetura](../ARCHITECTURE.md) · [contratos HTTP](API.md) · [testes](TESTING.md) · [auditoria final](FINAL_DELIVERY_AUDIT.md) · [checklist](DELIVERY_CHECKLIST.md).

**Nota sobre o histórico:** houve CI vermelho em commits intermediários. Não se deve apagar essas tentativas para fazer uma declaração de sucesso; o gate relevante é a execução vinculada ao commit final.

## Autorização — Tarefas 1 e 2

Complementa R02, R05, R12, R19 e R31 sem mudar os contratos financeiros.
A [ADR-019](adr/019-provider-resource-authorization.md) contém matriz, legados,
implementação e rollback. [Testes HTTP](../test/integration/provider-authorization-audit.spec.ts)
agora exigem isolamento; [testes PostgreSQL](../test/integration/authorization-persistence.spec.ts)
validam grants, constraints, concorrência, revogação e rollback/restauração.
Ambos são registrados no runner obrigatório; a execução local da Tarefa 2 está
registrada em [progresso](14_PROGRESS.md), sem alegar aprovação de CI remoto.

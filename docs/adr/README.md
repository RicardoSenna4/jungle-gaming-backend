# Índice de Architecture Decision Records

O registro oficial de decisões deste repositório está em [`docs/02_ADR_REGISTER.md`](../02_ADR_REGISTER.md). Este índice ajuda o avaliador a navegar sem duplicar decisões ou renomear arquivos existentes.

| ADR | Assunto | Evidência |
|---|---|---|
| 001–002 | Monólito modular, NestJS, MikroORM | [AppModule](../../src/app.module.ts) |
| 003, 005 | Money, PostgreSQL e ledger append-only | [Money](../../src/domain/money.ts), [migrations](../../src/infrastructure/database/migrations/Migration20261113150000.ts) |
| 004 | Lock por wallet | [Processador](../../src/application/wager-processing.service.ts), [concorrência](../../test/integration/concurrency.spec.ts) |
| 006, 011, 012 | Idempotência, hash e snapshot | [Hash](../../src/application/canonical-hash.ts), [concurrency B](../../test/integration/concurrency.spec.ts) |
| 007, 008 | Inbox/Outbox SQL transacional | [Consumer](../../src/infrastructure/workers/wager-transaction.consumer.ts), [Publisher](../../src/infrastructure/workers/outbox-publisher.worker.ts) |
| 009, 013 | Pendências e reversões mistas | [Testes](../../test/integration/reversal-processing.spec.ts) |
| 010 | Contratos HTTP | [API](../API.md), [controller](../../src/interfaces/http/app.controller.ts) |
| 014–015 | Eventos e filas | [Eventos](../../src/domain/events/wager-events.ts) |
| 016 | Auth opcional e extensão concreta | [Guard](../../src/interfaces/http/provider-identity.guard.ts) |
| 017–018 | Métricas e reconciliação | [Métricas](../../src/infrastructure/telemetry/metrics.service.ts), [wallet](../../src/application/wallets/wallet-repository.ts) |

| 019 (proposta) | Autorização por identidade e vínculos persistentes, wallets compartilhadas | [Auditoria e matriz](019-provider-resource-authorization.md) |

ADRs registram **por que** as decisões foram tomadas; os [testes](../TESTING.md) mostram o que foi **efetivamente executado**. A especificação prevalece: [`CHALLENGE_SPEC.md`](../../CHALLENGE_SPEC.md).

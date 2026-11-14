# Arquitetura

A solução usa NestJS + TypeORM + PostgreSQL. O domínio monetário usa strings com escala fixa de duas casas e `decimal.js`; dinheiro nunca é representado por `number`. O saldo é protegido por `SELECT FOR UPDATE` na transação SQL e o banco aplica `CHECK balance >= 0`, unicidade de wallet/transação e trigger append-only no ledger.

A primeira entrega implementa wallets, OPENING atômica, BET/WIN/LOSS/REFUND/ROLLBACK básicos, idempotência persistente por `(providerId, idempotencyKey)`, hash SHA-256 de JSON canônico e replay com snapshot do saldo original. A autenticação não foi implementada por não pontuar no desafio; o ponto de extensão é um guard NestJS futuro.

Pendências conscientes: inbox/outbox, consumidores SQS, worker de referências pendentes, health readiness real, paginação/reconciliação e testes de PostgreSQL/SQS precisam da infraestrutura Docker, ausente neste sandbox. Não são declarados como concluídos.

## Plano arquitetural da Fase 0

O planejamento completo para a implementação incremental está em [`docs/20_ARCHITECTURE_PLAN.md`](./docs/20_ARCHITECTURE_PLAN.md), incluindo organização DDD, diagrama de componentes, modelo lógico, fluxos financeiros, estratégia de locks, idempotência, inbox/outbox, referências fora de ordem, contratos HTTP, testes e dependências entre fases.

As decisões formais desta fase estão em [`docs/02_ADR_REGISTER.md`](./docs/02_ADR_REGISTER.md). O plano escolhe MikroORM como ORM de implementação, apesar da implementação histórica ainda usar TypeORM; essa migração é uma decisão para a próxima fase de código e não foi executada nesta tarefa.

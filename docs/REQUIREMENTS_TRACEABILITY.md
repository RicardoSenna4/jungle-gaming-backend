# Matriz de rastreabilidade — baseline F00

**Repositório:** `RicardoSenna4/jungle-gaming-backend`
**SHA auditado:** `688ba474e1bff084a2c72495ba3616444a2c2338` (`main`, 15/11/2026)
**Fonte normativa:** `CHALLENGE_SPEC.md`, comparado byte a byte com o README upstream em 15/11/2026; SHA-256 de ambos: `47795fce2fc38cae5f1b91368ebaf80b7a2ed1fe147f36704b665faf0613812e`.
**Regra:** esta tabela descreve evidência do SHA-base, não presume que código ou testes históricos equivalham a aprovação no CI desse SHA.

## Legenda de resultado


- **PASS — unit:** teste unitário executado e aprovado no job `verify`; não prova integração real.
- **SKIP — CI:** cenário condicionado por variável de ambiente e contado como ignorado no `bun test` do job `verify`.
- **PASS — SQS limitado:** o teste LocalStack executou no job `integration-services`, mas suas assertions atuais não provam todo o contrato de ACK/redelivery/DLQ.
- **PARCIAL / SEM EVIDÊNCIA:** existe código, configuração ou relato anterior, mas falta a evidência exigida no CI do SHA-base.

A execução Actions-base `43751276240` terminou verde. O job `verify` reportou **30 pass, 29 skip, 0 fail**; o job `integration-services` executou uma única spec SQS real. As 29 specs condicionais não foram convertidas em aprovadas por o processo terminar com exit code zero.

| ID | Requisito oficial | Código/testes relacionados | Resultado no SHA-base | Gravidade e pendência |
|---|---|---|---|---|
| R01 | Stack Bun, TS strict, NestJS, PostgreSQL, SQS, Compose | `package.json`, `docker-compose.yml`, `.github/workflows/ci.yml` | Parcial: stack declarada; CI sobe PG/LocalStack | P1: reproduzir caminho completo da solução em runner limpo |
| R02 | ORM permitido e migrations versionadas/reversíveis | `src/infrastructure/database/migrations/*`, `db:migrate`, `db:rollback` | Parcial: CI migra up e chama down uma vez | P0/F01: provar rollback de toda a cadeia e novo up |
| R03 | Money imutável, decimal exato, string de duas casas | `src/domain/money.ts`, `test/unit/money.spec.ts` | PASS — unit | P1: completar extremos/limites no gate de qualidade |
| R04 | Factories/rehydrate e domínio sem dependência ORM/Nest | `src/domain/*`, `test/unit/domain-entities.spec.ts` | Parcial: unit executada; auditoria arquitetural não é gate automatizado | P1: confirmar por inspeção e testes de construção |
| R05 | Uma wallet por player/moeda; versionamento | migration de wallets, `wallet-persistence.spec.ts` | SKIP — CI (`wallet-persistence.spec.ts`) | P0: executar contra PostgreSQL real no CI |
| R06 | Saldo não negativo e proteção contra lost update | migration, `concurrency.spec.ts` | SKIP — CI (4 cenários de concorrência) | P0: executar cenários reais multiprocesso |
| R07 | OPENING interno, wallet/ledger atômicos | `wallet-persistence.spec.ts` | SKIP — CI | P0: executar integração PostgreSQL e rollback |
| R08 | BET debita; insuficiência rejeita sem ledger | `wager-processing.spec.ts`, `wager-processing.service.ts` | Fluxo de produção SKIP — CI; unit não prova persistência | P0: executar integração real |
| R09 | WIN credita e LOSS não altera saldo/ledger | `wager-processing.spec.ts` | Fluxo de produção SKIP — CI | P0: executar integração real e conferir version/ledger |
| R10 | REFUND só reverte BET processada, mesmo contexto e valor | `reversal-processing.spec.ts` | SKIP — CI | P0: executar integração real e disputa concorrente |
| R11 | ROLLBACK inverte BET/WIN/REFUND; débito pode ser rejeitado | `reversal-processing.spec.ts` | SKIP — CI | P0: executar integração real |
| R12 | Referência por provider/ID externo e mesmo contexto | `reversal-processing.spec.ts`, `wager-processing.spec.ts` | SKIP — CI | P0: executar integração real de isolamento |
| R13 | Referência ausente fica pending; worker, retry, TTL e rejeição auditável | `pending-reference.worker.ts`, `reversal-processing.spec.ts` | SKIP — CI | P0: testar integração, agendamento e restart |
| R14 | Estados financeiros terminais não transicionam | `wager-transaction.ts`, `domain-entities.spec.ts`, migrations | PASS — unit para domínio; persistência não verificada | P1: provar também no caminho de banco |
| R15 | Ledger append-only, balanceado e único por wallet/transação | migration, `wallet-persistence.spec.ts` | SKIP — CI | P0: executar UPDATE/DELETE e constraints por SQL real |
| R16 | Reconciliação compara wallet e ledger sem autocorreção | `wallet-reconciliation.spec.ts`, `wallet-persistence.spec.ts` | PASS — unit; integração PostgreSQL SKIP — CI | P1: validar snapshot e divergência em DB real |
| R17 | Idempotency-Key durável e replay preserva saldo original | `wager-processing.spec.ts`, `concurrency.spec.ts` | SKIP — CI para o fluxo de banco | P0: executar serial, paralelo e recovery |
| R18 | Payload divergente conflita; hash canônico documentado | `canonical-hash.spec.ts`, `wager-processing.spec.ts` | PASS — unit para hash; conflito SQL SKIP — CI | P0: executar teste de conflito no fluxo real |
| R19 | Endpoints e contratos HTTP obrigatórios | `http-api.spec.ts`, controllers e DTOs | SKIP — CI (`http-api.spec.ts`) | P0: executar integração HTTP com PostgreSQL |
| R20 | SQS FIFO/DLQ, use case comum, Inbox persistente | `sqs-consumer.spec.ts`, `sqs-localstack.spec.ts` | PASS — SQS limitado; testes Inbox SKIP — CI | P0: provar Inbox, duplicatas e redelivery reais |
| R21 | ACK após commit; retry, DLQ e shutdown seguros | consumer, `sqs-consumer.spec.ts`, `sqs-localstack.spec.ts` | PASS — SQS limitado; demais cenários SKIP — CI | P0: testar falhas antes/depois do commit e DLQ |
| R22 | Inbox, saldo, ledger e outbox na mesma transação | `wager-processing.service.ts`, `wallet-persistence.spec.ts` | SKIP — CI | P0: executar rollback/crash com PostgreSQL |
| R23 | Outbox após commit, claims concorrentes, retry e recovery | `outbox-publisher.worker.ts`, `outbox-publisher.spec.ts` | SKIP — CI; há relato local histórico não equivalente a este gate | P0: executar PostgreSQL real e pontos de falha exigidos |
| R24 | Eventos mínimos, envelope versionado e classes concretas | `src/domain/events/*`, `events.spec.ts` | PASS — unit | P1: validar envelopes persistidos no fluxo integrado |
| R25 | Duas BET 80 sobre saldo 100: uma processada, saldo 20 | `concurrency.spec.ts` cenário A | SKIP — CI | P0: executar multiprocesso em PostgreSQL real |
| R26 | 50 duplicatas, ≥3 processos e wallets paralelas | `concurrency.spec.ts` cenários B–D | SKIP — CI | P0: executar os cenários sem mock sequencial |
| R27 | Pending fora de ordem, publisher duplo, restart e consistência | testes de reversal/outbox/consumer/concurrency | SKIP — CI, exceto SQS simples | P0: executar recovery/restart e comparar saldo/ledger |
| R28 | Logs JSON redigidos e métricas necessárias | `metrics.service.spec.ts`, serviços de telemetry | PASS — unit parcial; formato/redaction do log não cobertos | P1: adicionar/verificar testes específicos de logs |
| R29 | `/health/live` e `/health/ready` com PG e SQS | health unit e `http-api.spec.ts` | PASS — unit; HTTP/integridade real SKIP — CI | P1: testar serviços online/offline via integração |
| R30 | README/ARCHITECTURE honestos e reproduzíveis | `README.md`, `ARCHITECTURE.md` | Documentos existem; reprodução limpa não demonstrada | P1: revalidar depois do gate integral |
| R31 | Auth externa se implementada; caso contrário, decisão/extensão | `ARCHITECTURE.md`, ADRs | Não verificado nesta fase; autenticação não é critério pontuado no enunciado | P1: confirmar extensão e decisão na fase de API |
| R32 | Testes reais de migrations, Inbox/Outbox, retry/DLQ e crash | todas as specs de integração | Sem cobertura integral no CI-base; 29 ignorados | P0: gate F01 deve executar as suítes sem skips |
| R33 | Sem lock global, sem FIFO como única garantia, ORM permitido | domínio, serviços, migrations e configuração | Não auditado por execução nesta fase | P0: requer revisão técnica nas fases subsequentes |
| R34 | FailureCode estável e HTTP distinto por tipo de erro | `failure-code.ts`, `http-api.spec.ts`, testes de aplicação | Parcial: unit executada; HTTP de integração SKIP — CI | P1: comprovar status/body no fluxo integrado |

## Limite desta matriz

F00 identifica o que o CI-base provou e o que não provou. Não declara o projeto conforme nem altera a interpretação do enunciado. A branch de correção F00/F01 adiciona um gate para executar os testes existentes; não corrige, por si só, lacunas de comportamento das fases posteriores.

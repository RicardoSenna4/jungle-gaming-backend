# Registro de ADRs — Jungle Gaming Backend Challenge

**Data da decisão:** 2026-11-13
**Escopo:** planejamento arquitetural; nenhuma ADR abaixo representa código já validado.

| ADR | Tema | Estado | Decisão | Requisitos |
|---|---|---|---|---|
| ADR-001 | Organização | ACCEPTED | Monólito NestJS modular com roles API, consumer, outbox e pending worker | R01, R04, R20 |
| ADR-002 | ORM | ACCEPTED | MikroORM, com EntityManager transacional explícito e migrations | R02, R22 |
| ADR-003 | Dinheiro | ACCEPTED | Money independente do ORM, decimal.js, strings escala 2, PostgreSQL NUMERIC(20,2) | R03 |
| ADR-004 | Concorrência | ACCEPTED | `SELECT FOR UPDATE` por wallet dentro de transação SQL | R06, R25, R26 |
| ADR-005 | Constraints | ACCEPTED | Unicidade/checks/foreign keys no schema e trigger append-only para ledger | R05, R06, R15 |
| ADR-006 | Idempotência | ACCEPTED | Unique persistente por provider/key e provider/external ID, payload hash canônico e response snapshot | R17, R18 |
| ADR-007 | Inbox | ACCEPTED | `(consumerName,messageId)` persistente na mesma transação financeira; ACK pós-commit | R20, R21, R22 |
| ADR-008 | Outbox | ACCEPTED | Outbox atômica, claim por lease/SKIP LOCKED, publicação pós-commit e retry | R22, R23 |
| ADR-009 | Referências | ACCEPTED | `PENDING_REFERENCE` com worker, backoff, TTL e rejeição auditável | R13, R27 |
| ADR-010 | HTTP | ACCEPTED | 400 inválido, 409 conflito, 422 regra, 202 pendente, 503 infra; 404 em consultas | R19, R34 |
| ADR-011 | Hash | ACCEPTED | SHA-256 de JSON canônico recursivamente ordenado, apenas campos de negócio | R18 |
| ADR-012 | Replay | ACCEPTED | Snapshot do saldo no instante original; replay não consulta saldo atual para substituir o snapshot | R17 |
| ADR-013 | Reversões mistas | ACCEPTED | Política conservadora: impedir segunda reversão econômica direta da mesma referência | R10, R11 |
| ADR-014 | Eventos | ACCEPTED | Envelope abstrato versionado e subclasses concretas; MoneyProps nos payloads | R24 |
| ADR-015 | Filas | ACCEPTED | Fila de eventos separada da fila de comandos para evitar loops | R20, R23, R24 |
| ADR-016 | Autenticação | ACCEPTED | Não implementar auth própria; preparar ProviderIdentityPort/guard para IdP OIDC externo | R31 |
| ADR-017 | Observabilidade | ACCEPTED | Logs JSON sem payload sensível, métricas de status/retry/DLQ/locks/outbox/latência | R28, R29 |
| ADR-018 | Reconciliação | ACCEPTED | Soma decimal do ledger em snapshot consistente; divergência sinalizada, nunca autocorrigida | R16, R19 |

## ADR-001 — Monólito modular

**Contexto:** microserviços aumentariam falhas de rede sem melhorar as garantias centrais.
**Alternativa:** microserviços separados por wallet/messaging; rejeitada por complexidade e ausência de benefício para o desafio.
**Efeito:** um binário pode operar em múltiplas instâncias e roles; o domínio continua isolado.

## ADR-002 — MikroORM

**Contexto:** o enunciado declara MikroORM preferencial e exige transações/migrations.
**Alternativa:** TypeORM, aceito mas menos alinhado à preferência.
**Efeito:** usar `EntityManager.transactional`, Unit of Work e locks explícitos; nenhum decorator invade o domínio.

## ADR-003 — Money

**Contexto:** dinheiro não pode usar `number`, float ou double.
**Alternativa:** inteiros de centavos; seria exato, mas exigiria converter o contrato decimal e documentar escala.
**Efeito:** decimal.js no domínio, strings nos contratos/eventos e NUMERIC no banco.

## ADR-004 — Lock por wallet

**Contexto:** read-calculate-update sem controle é eliminatório.
**Alternativa:** optimistic locking com retry; possível, mas mais sensível a retry e hot wallet.
**Efeito:** row lock previsível, contenção limitada à wallet e teste real C02/C03 obrigatório.

## ADR-006 — Idempotência persistente

**Contexto:** retries HTTP/SQS e crashes exigem que a base sobreviva ao restart.
**Alternativa:** cache local/Redis/FIFO; rejeitada como garantia final.
**Efeito:** constraints SQL, hash canônico e snapshot de resposta.

## ADR-007/008 — Inbox e Outbox

**Contexto:** ACK/publicação não podem anteceder commit, mas DB e SQS não oferecem transação distribuída única.
**Alternativa:** publicar dentro da transação ou ACK antes; rejeitada por perda/duplicação insegura.
**Efeito:** inbox/outbox duráveis no commit, ACK/publish posteriores, duplicatas toleradas por eventId/idempotência.

## ADR-009 — Referências fora de ordem

**Contexto:** dependentes podem chegar antes da referência.
**Alternativa:** rejeitar imediatamente ou aguardar indefinidamente; ambas violam o comportamento esperado.
**Efeito:** pending persistente, backoff, TTL e failureCode final.

## ADR-013 — Reversões mistas

**Contexto:** o README proíbe repetição do mesmo tipo, mas permitir REFUND e ROLLBACK da mesma BET pode duplicar efeito econômico.
**Decisão:** política conservadora: uma reversão econômica direta por referência; permitir cadeias explícitas apenas quando o efeito e as constraints forem modelados.
**Prova necessária:** C10 com duas reversões concorrentes e cadeia de rollback.

## ADR-016 — Autenticação

**Contexto:** autenticação não pontua e o desafio exige IdP externo se implementada.
**Decisão:** não criar auth artesanal; adicionar ponto de extensão para OIDC e manter endpoints de health abertos.
**Risco:** API sem guard não é para exposição pública; deve constar no README final.

## Gates

Estas decisões são de planejamento. A implementação deve adicionar testes RED/GREEN e atualizar cada ADR com evidência de comando, exit code, ambiente e commit. Nenhuma decisão substitui requisito explícito do README oficial.

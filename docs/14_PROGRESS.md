# Progresso e rastreabilidade — Jungle Gaming Backend

Este documento registra as decisões, implementações, evidências e limitações de cada tarefa executada no repositório. Gates não executados por indisponibilidade de infraestrutura permanecem explicitamente pendentes.

## Tarefa 1 — Discovery e análise — 2026-11-13

Foi realizada a leitura integral do README oficial, da especificação do desafio e do kit de orientação. Foram catalogados requisitos obrigatórios, opcionais e eliminatórios; regras financeiras; endpoints; eventos; entidades; workers; integrações; concorrência; idempotência; falhas; recuperação e critérios de avaliação.

O diagnóstico foi registrado em `docs/19_DISCOVERY_DIAGNOSTIC.md`. Os maiores riscos identificados foram precisão monetária, saldo/ledger divergentes, duplicidade sob concorrência, referências fora de ordem, ack prematuro de SQS e publicação de outbox sem garantia de entrega.

Estado: concluída sem implementação de código.

## Tarefa 2 — Planejamento arquitetural — 2026-11-13

Foi definida uma arquitetura NestJS modular com separação entre domínio, aplicação, infraestrutura e interfaces HTTP. PostgreSQL foi escolhido como fonte de verdade para wallet, ledger, idempotência, Inbox e Outbox. MikroORM foi escolhido como ORM ativo. A concorrência foi definida por `walletId`, usando lock pessimista por linha e sem lock global.

Foram definidos Money decimal exato, aggregate Wallet, ledger append-only, Inbox/Outbox transacionais, canonicalização de payload, retries limitados, referências pending, health checks, métricas, reconciliação e semântica at-least-once.

Artefatos: `ARCHITECTURE.md`, `docs/20_ARCHITECTURE_PLAN.md` e `docs/02_ADR_REGISTER.md`.

Estado: concluída sem implementação de código.

## Tarefa 3 — Infraestrutura e bootstrap — 2026-11-13

Foi configurado Bun 1.1.38 como runtime, package manager e test runner; NestJS com TypeScript strict; MikroORM/PostgreSQL; migrations reversíveis; Docker Compose com PostgreSQL 16 e LocalStack SQS; filas FIFO, fila de eventos, DLQ e redrive policy; `.env.example`; scripts de build, teste, lint, format e migration; estrutura inicial de workers; e CI básico.

Evidências: Bun instalado, build/typecheck/lint/format executáveis e migration CLI configurado. O primeiro ambiente Manus não possuía Docker/LocalStack; essa limitação foi registrada em vez de declarar o serviço aprovado.

Estado: implementada; gate de Docker dependente do ambiente.

## Tarefa 4 — Domínio financeiro com TDD — 2026-11-13

Foram implementados Money imutável com decimal exato e serialização string; Wallet; WagerTransaction; WalletLedgerEntry; InboxMessage; OutboxMessage; IntegrationEvent e eventos concretos; códigos de falha e erros tipados.

Os testes cobrem escala decimal, moedas incompatíveis, entradas inválidas, saldo insuficiente, reidratação, transições terminais, invariantes do ledger e retry/backoff.

Estado: concluída. Testes unitários aprovados.

## Tarefa 5 — Schema, persistência e wallets — 2026-11-13

Foram criadas migrations e entidades MikroORM para wallets, wager transactions, ledger, Inbox e Outbox. O schema possui unicidades, checks monetários, índices, referências, trigger append-only e constraints de identidade externa.

Foram implementados:

- `POST /wallets`;
- `GET /wallets/:walletId`;
- `GET /wallets/:walletId/ledger` com cursor opaco;
- criação transacional de OPENING e CREDIT inicial;
- unicidade por player/currency;
- versionamento inicial em 1;
- reconciliação materializado versus ledger.

Testes PostgreSQL cobrem criação, saldo zero, crédito inicial, duplicidade, rollback, constraints e imutabilidade do ledger.

Estado: concluída.

## Tarefa 6 — Processamento financeiro e idempotência — 2026-11-13

Foi implementado o caso de uso central reutilizado por HTTP e SQS para BET, WIN e LOSS. `Idempotency-Key` é obrigatória. O hash usa canonicalização determinística do payload de negócio. O primeiro resultado é salvo em `response_snapshot`; replay retorna o saldo observado originalmente; payload divergente retorna conflito.

BET debita somente com saldo suficiente; WIN credita; LOSS não movimenta saldo; transação, alteração de wallet, ledger e outbox são persistidas na mesma transação SQL. Foram definidos códigos HTTP para contrato, conflito, rejeição, pending e falhas transitórias.

Estado: concluída. Testes unitários, de integração e concorrência aprovados.

## Tarefa 7 — Concorrência e consistência — 2026-11-13

Foi comprovado lock por wallet com PostgreSQL real e múltiplos processos:

- duas BET concorrentes de 80,00 sobre saldo 100,00 produzem uma aprovação e uma rejeição;
- 50 submissões da mesma idempotency key produzem um único efeito;
- wallets diferentes são processadas em paralelo;
- três processos independentes mantêm saldo e ledger consistentes;
- retries limitados tratam unique race, deadlock e serialization failure.

Também foram adicionados cursor estável, reconciliação e testes de consistência final.

Estado: concluída com PostgreSQL real.

## Tarefa 8 — REFUND, ROLLBACK e referências fora de ordem — 2026-11-14

Foram implementados REFUND e ROLLBACK no mesmo caso de uso. A referência é resolvida por provider e external transaction ID. São validados player, wallet, currency, round, tipo permitido e valor integral. Reversões duplicadas e reversões que causariam saldo negativo possuem códigos distintos.

Referências ausentes são persistidas como `PENDING_REFERENCE`, com tentativas, backoff exponencial, TTL e `REFERENCE_RETRY_EXHAUSTED`. O worker de pending reprocessa a operação sem criar uma segunda identidade financeira. Eventos de processado, rejeitado e pending são enviados pela Outbox transacional.

Estado: concluída em PostgreSQL real.

## Tarefa 9 — Consumer SQS e Inbox transacional — 2026-11-14

Foi implementado o consumer da `wager-transactions.fifo`, com validação do envelope e allowlist opcional de provider. O consumer reutiliza exatamente o `WagerProcessingService`, registra Inbox por `(consumerName, messageId)`, faz ack somente depois do commit e deixa falhas não confirmáveis para redrive/DLQ. O shutdown interrompe polling e aguarda operações em andamento.

A configuração inclui `wager-transactions-dlq.fifo`, redrive policy e `wager-events.fifo`. Testes locais de consumer cobrem Inbox, redelivery e mensagens inválidas. O teste end-to-end com LocalStack existe e agora é executado explicitamente no job de integração do GitHub Actions.

Estado: código implementado; execução local bloqueada quando Docker/LocalStack não estão instalados. O resultado do CI deve ser usado como evidência do gate real.

## Tarefa 10 — Outbox publisher, observabilidade e reconciliação — 2026-11-14

Foi implementado `OutboxPublisherWorker` com `FOR UPDATE SKIP LOCKED`, lease, `claim_token`, publicação fora da transação, marcação somente após envio, retry exponencial e shutdown. A entrega é at-least-once; crash entre envio e `published_at` pode gerar redelivery.

Foram implementados health live/readiness, métricas Prometheus, logs estruturados e endpoint de reconciliação. O legado TypeORM foi removido para manter MikroORM como fonte única de migrations.

Testes PostgreSQL cobrem claim concorrente, retry e recuperação após falha equivalente a crash entre envio e marcação publicada.

Estado: implementada.

## Tarefa 11 — Correções finais e contratos HTTP — 2026-11-15

Foram feitas as seguintes correções:

1. Criado `event-factory.ts`, que instancia `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference` e `WalletBalanceChanged` como subclasses concretas do envelope de integração.
2. O processamento financeiro passou a persistir os envelopes serializados pelas classes concretas, em vez de montar strings de evento genericamente.
3. OPENING positivo passou a gerar, na mesma transação SQL, `WagerTransactionProcessed` e `WalletBalanceChanged`, com saldo anterior, saldo posterior e wallet version.
4. Foram criados DTOs com `class-validator` para wallets, Money e wagering. O `ValidationPipe` global já configurado agora valida efetivamente os contratos HTTP.
5. Foram adicionados testes HTTP reais usando Nest, `fetch` e PostgreSQL para criação/consulta de wallet, ledger, BET, replay idempotente, consultas de transação, reconciliação, health e métricas.
6. Foi corrigida a paginação do ledger: a consulta usava placeholders PostgreSQL posicionais em um caminho que recebe placeholders do driver MikroORM, causando HTTP 500. A consulta agora usa placeholders compatíveis e o teste HTTP cobre o caminho.
7. Foi adicionado teste de recuperação do publisher após falha equivalente a crash entre envio SQS e marcação `published_at`.
8. O CI passou a executar o teste `sqs-localstack.spec.ts` com `RUN_SQS_REAL=1` depois de subir PostgreSQL e LocalStack.

Estado: implementada localmente; CI deve executar o gate SQS real.

## Evidências executadas nesta etapa

No sandbox atual:

- PostgreSQL local: disponível e aceitando conexões.
- Docker: indisponível (`docker: command not found`).
- LocalStack: indisponível em `localhost:4566`.
- `bun run format`: aprovado.
- `bun run typecheck`: aprovado.
- `bun run lint`: aprovado.
- `bun run build`: aprovado antes do fechamento deste registro; repetir no gate final.
- testes de wallet/OPENING: 6 aprovados.
- testes de outbox, incluindo crash-equivalent: 4 aprovados.
- testes HTTP reais: 2 aprovados.
- teste LocalStack real: não executado localmente por ausência de Docker.

Comando para reprodução no ambiente com Docker:

```bash
docker compose up -d postgres localstack
bun run db:migrate
RUN_INTEGRATION=1 RUN_SQS_REAL=1 bun test test/integration/sqs-localstack.spec.ts
bun test
```

## Matriz de rastreabilidade final

| Requisito | Implementação | Evidência | Estado |
|---|---|---|---|
| Precisão monetária | `Money` + `NUMERIC(20,2)` | testes unitários/integração | Aprovado |
| Wallet por player/currency | constraint SQL | wallet persistence | Aprovado |
| Ledger imutável | trigger + checks | PostgreSQL | Aprovado |
| Idempotência HTTP | hash + snapshot | wager/concurrency/HTTP | Aprovado |
| Lock por wallet | `FOR UPDATE` | concurrency A-D | Aprovado |
| BET/WIN/LOSS | caso de uso central | integração | Aprovado |
| REFUND/ROLLBACK | referência e reversão | reversal processing | Aprovado |
| Pending reference | worker/backoff/TTL | reversal processing | Aprovado |
| Inbox SQS | chave composta e commit | consumer integration | Aprovado em código; E2E depende CI |
| Ack após commit | `handleAndAck` | consumer code/test | Aprovado em código; crash E2E depende CI |
| DLQ/redrive | Compose/init policy | config + teste condicionado | Gate real depende CI |
| Outbox atômica | persistência transacional | integração | Aprovado |
| Publisher concorrente | claim/lease/token | PostgreSQL | Aprovado |
| Crash do publisher | retry após falha entre send/mark | outbox integration | Aprovado por simulação equivalente |
| OPENING events | factory + outbox | wallet persistence | Aprovado |
| Contratos HTTP | DTOs + ValidationPipe | HTTP integration | Aprovado |
| Health/readiness | controllers + dependency checks | unit/HTTP | Aprovado |
| Métricas/logs | Prometheus/JSON logs | unit/smoke | Aprovado |
| CI | workflow Bun + services + SQS E2E | GitHub Actions | Em execução após este commit |
| Autenticação | fora do escopo pontuado | ADR | Não implementada por decisão documentada |

## Pendências honestas

A única limitação de execução local desta etapa é a ausência de Docker/LocalStack. O código e o teste E2E estão preparados, e o CI foi alterado para executar o cenário real. A prova final de redelivery, DLQ, restart e crash pós-commit/pré-ack deve ser confirmada pelo workflow com containers, sem ser inferida apenas dos testes unitários.

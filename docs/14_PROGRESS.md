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

| Requisito                  | Implementação                     | Evidência                   | Estado                                   |
| -------------------------- | --------------------------------- | --------------------------- | ---------------------------------------- |
| Precisão monetária         | `Money` + `NUMERIC(20,2)`         | testes unitários/integração | Aprovado                                 |
| Wallet por player/currency | constraint SQL                    | wallet persistence          | Aprovado                                 |
| Ledger imutável            | trigger + checks                  | PostgreSQL                  | Aprovado                                 |
| Idempotência HTTP          | hash + snapshot                   | wager/concurrency/HTTP      | Aprovado                                 |
| Lock por wallet            | `FOR UPDATE`                      | concurrency A-D             | Aprovado                                 |
| BET/WIN/LOSS               | caso de uso central               | integração                  | Aprovado                                 |
| REFUND/ROLLBACK            | referência e reversão             | reversal processing         | Aprovado                                 |
| Pending reference          | worker/backoff/TTL                | reversal processing         | Aprovado                                 |
| Inbox SQS                  | chave composta e commit           | consumer integration        | Aprovado em código; E2E depende CI       |
| Ack após commit            | `handleAndAck`                    | consumer code/test          | Aprovado em código; crash E2E depende CI |
| DLQ/redrive                | Compose/init policy               | config + teste condicionado | Gate real depende CI                     |
| Outbox atômica             | persistência transacional         | integração                  | Aprovado                                 |
| Publisher concorrente      | claim/lease/token                 | PostgreSQL                  | Aprovado                                 |
| Crash do publisher         | retry após falha entre send/mark  | outbox integration          | Aprovado por simulação equivalente       |
| OPENING events             | factory + outbox                  | wallet persistence          | Aprovado                                 |
| Contratos HTTP             | DTOs + ValidationPipe             | HTTP integration            | Aprovado                                 |
| Health/readiness           | controllers + dependency checks   | unit/HTTP                   | Aprovado                                 |
| Métricas/logs              | Prometheus/JSON logs              | unit/smoke                  | Aprovado                                 |
| CI                         | workflow Bun + services + SQS E2E | GitHub Actions              | Em execução após este commit             |
| Autenticação               | fora do escopo pontuado           | ADR                         | Não implementada por decisão documentada |

## Pendências honestas

A única limitação de execução local desta etapa é a ausência de Docker/LocalStack. O código e o teste E2E estão preparados, e o CI foi alterado para executar o cenário real. A prova final de redelivery, DLQ, restart e crash pós-commit/pré-ack deve ser confirmada pelo workflow com containers, sem ser inferida apenas dos testes unitários.

## F00 — confirmação do baseline e rastreabilidade — 2026-11-15

Foi confirmado que `CHALLENGE_SPEC.md` é byte a byte idêntico ao README upstream. No SHA-base `688ba474e1bff084a2c72495ba3616444a2c2338`, `bun test` reportou 30 aprovados, 29 ignorados e zero falhas; a execução GitHub Actions `43751276240` terminou verde, mas o job `verify` não executou as integrações PostgreSQL. O job com serviços executou apenas uma spec SQS real. A CI-base aplicou migrations e chamou rollback uma única vez, não demonstrando o rollback completo das quatro migrations.

Evidências e classificação dos achados foram registradas em `docs/EVIDENCE_BASELINE.md`, `docs/AUDIT_FINDINGS.md` e `docs/REQUIREMENTS_TRACEABILITY.md`. Foi criada a branch isolada `fix/challenge-f00-f01`; `main` não foi modificada.

Estado: baseline confirmado; F00 concluída.

## F01 — execução integral dos testes no GitHub Actions — 2026-11-15

O runner `scripts/run-required-tests.ts` / `scripts/test-suite-runner.ts` executa arquivos de teste em série, gera JUnit e logs individuais, e faz o gate falhar com exit code diferente de zero, suite sem testes, falha, erro ou qualquer teste ignorado. Antes das suítes de integração, descobre recursivamente as specs existentes e exige correspondência exata com o registro (sem omissões, caminhos obsoletos ou duplicatas). Foram adicionados scripts explícitos para testes unitários, integração PostgreSQL, SQS real, concorrência, recuperação e execução completa. O workflow agora inicia PostgreSQL e LocalStack em um runner descartável, aguarda as três filas, aplica as migrations, executa todas as specs existentes sem removê-las, verifica migrations pendentes, reverte cada migration em sequência, reaplica a cadeia e publica artefatos de teste.

Validações locais no código F01:

- `bun run format` e `bun run format:check`: aprovados.
- `bun run typecheck`: aprovado.
- `bun run lint`: aprovado.
- `bun run build`: aprovado.
- `bun run test:unit`: 34 aprovados, 0 falhas, 0 ignorados (98 assertions).
- Testes de fail-closed: uma spec unitária temporária deliberadamente falha e uma spec de integração temporária não registrada foram criadas e removidas no mesmo comando de prova; o runner rejeitou ambas com exit code não zero, e a de integração foi rejeitada antes de executar qualquer integração. Não foi removido ou desativado nenhum teste existente.
- Integrações PostgreSQL/LocalStack locais: BLOQUEADAS / não executadas, pois `docker` não está instalado neste sandbox. Isso não é registrado como skip nem aprovação.
- GitHub Actions da branch F00/F01: PENDENTE até publicação e execução do workflow.

O README foi alinhado aos novos comandos e ao requisito de serviços. F02 e fases posteriores não foram iniciadas, respeitando o limite solicitado.

## Fechamento das correções — 15/11/2026

- Integrado `fix/challenge-f00-f01` por fast-forward, commit `6dc45fc`.
- Integrado `fix/challenge-final-remediation` por fast-forward, commit `3cdb0eb`.
- CI no commit de código `3cdb0eb`: [Actions 43760715469](https://github.com/RicardoSenna4/jungle-gaming-backend/actions/runs/43760715469), 80 PASS, 0 FAIL, 0 SKIP, PostgreSQL e LocalStack reais e migration chain up/down/up.
- Documentos finais: `docs/FINAL_DELIVERY_AUDIT.md`, `docs/REQUIREMENTS_TRACEABILITY.md` e `docs/DELIVERY_CHECKLIST.md`.
- Teste de instalação limpa pelo proprietário, verificação de acesso ao repositório privado e submissão oficial **ainda pendentes**.

## Formalização de FAILED e quarentena — 2026-11-16

`FAILED` foi formalizado como estado terminal operacional/permanente, distinto de `REJECTED` e `PENDING_REFERENCE`, sem qualquer alteração de wallet ou ledger. Foi criada a tabela `message_quarantine`, com migration reversível, payload bruto, motivo, contador de recebimentos, status operacional e timestamps de resolução.

Mensagens SQS inválidas ou permanentemente inconsistentes são persistidas na quarentena antes do ACK. Se a persistência falhar, continuam sem ACK e seguem retry/DLQ. Foram adicionados `GET /operations/quarantine` e `POST /operations/quarantine/:consumerName/:messageId/resolve`, protegidos pelo guard de identidade, além das métricas `quarantine_messages_total` e `sqs_messages_quarantined_total` e logs estruturados de quarentena.

Os testes de consumer foram atualizados para comprovar ACK pós-commit da quarentena e ausência de Inbox, transação financeira e ledger.

## 2026-11-16 — Tarefa 1: auditoria de autorização por provider

Base `origin/main` confirmada por fetch em `b4c0bad`; worktree isolado
`jungle-auth-audit`, branch `security/provider-authorization-audit`.
[ADR-019](adr/019-provider-resource-authorization.md) proposta: achados A1–A7,
matriz por endpoint, vínculos muitos-para-muitos, legados e migration reversível.
Sem enforcement novo, migration nova ou alteração financeira.
Sete testes reais de auditoria adicionados ao runner: autenticados permitidos,
negações já existentes e reproduções explicitamente identificadas como `AUDIT GAP`.
Bypass body/URL reproduzido no runtime Node suportado; a diferença de transporte
Bun está delimitada na ADR. A passagem desses testes não certifica isolamento.
Validação local: typecheck/lint/format/build passaram; sem migrations pendentes;
`test:all` com 93 testes em 13 targets, zero falhas/erros/skips, PG/LocalStack reais.
Nenhuma integração na main: CI dos novos commits não confirmado.

## 2026-11-16 — Tarefa 2: associações persistentes e enforcement OIDC

Worktree `/workspace/jungle-auth-bindings`, branch `security/provider-resource-bindings`,
baseada na Tarefa 1 (`c77401e`); `origin/main` atualizada por fetch em `b4c0bad`.
Checkouts anteriores preservados, sem mudanças locais do usuário sobrescritas.

Implementado: cinco entidades/tabelas de autorização, PKs compostas, FK de wallet
RESTRICT, CHECKs, índices e auditoria append-only por trigger. Provisionamento
idempotente/revogável em API administrativa interna; sem endpoint público para grants.
Identidades issuer/subject/provider e permissões por recurso são persistentes;
wallet admite múltiplos providers. OIDC nega sem binding/grant, desconhece recursos
não autorizados e verifica autorização antes de replay. Operadores têm grants
separados de leitura/resolução, sem provider fictício. Challenge preservado.

A autorização HTTP usa transação e locks compartilhados via EntityManager.execute;
revogação aguarda operações em curso. HTTP 422 preserva resultado REJECTED durável.
Nenhuma alteração nas regras financeiras, domínio ou cinco migrations históricas.
MikroORM snapshot ganhou cinco tabelas; os sete registros de tabelas anteriores
foram comparados estruturalmente e permaneceram idênticos. Sem atribuição automática
por histórico, OPENING, primeiro provider ou criação. Grants iniciais implícitos vazios.

Validação final nesta instância Linux (Bun 1.1.38, Node 24.22.1, PostgreSQL 16,
LocalStack 3.8, Docker Engine/Compose disponíveis; Docker Desktop local não confirmado):

- typecheck, lint, format:check e build passaram.
- test:all: **100 testes, 14 targets, zero falhas/erros/skips**; inclui concorrência,
  filas SQS reais e 13 casos de integração de segurança (8 HTTP, 5 PostgreSQL).
- Criar grants, duplicidades/constraints/índices, oito concessões simultâneas,
  revogação observada com waiters reais, reconcessão e issuer/sub/provider validados.
- Migration dedicada: banco descartável criado para o teste, história financeira
  de dois providers anterior à migration preservada; sem backfill; rollback sem
  confirmação recusado; down/up/restauração com metadados e grants revogados
  preservados; snapshots das seis tabelas financeiras/operacionais idênticos.
- db:migration:check sem pendências e docker compose config -q válido.
- pg_dump de autorização e checksum executados localmente com sucesso; CI passa
  a gerar esse backup antes do rollback da cadeia no banco descartável.
- Testes executados em `jungle_auth_bindings_test` e `authz_migration_*`; o banco
  original da Tarefa 1 não foi migrado/truncado por esta tarefa. Teste descarta só
  seu próprio authz_migration_* após uso. Relatórios JUnit em .test-results ignorado.
- Smoke de crash/restart do container não executado nesta tarefa; não houve
  alteração de Dockerfile, Compose ou algoritmos financeiros/workers.

Limites: OIDC exige provisionamento administrativo aprovado antes do rollout.
O store confia no processo administrativo; ator fornecido é atribuição, não login.
DB role de desenvolvimento do Compose é privilegiada; DDL/TRUNCATE/provisionamento
precisam de credenciais separadas em produção. Sem RLS, IdP hospedado, ingress
externo autenticado de SQS ou UI administrativa. Backups/auditoria exigem acesso
restrito. AUTHZ_ROLLBACK_BACKUP_CONFIRMED é confirmação operacional, não verificação
automática de backup. Não reabrir OIDC com versão antiga permissiva no rollback.

Branch separada, sem push/merge; CI dos novos commits não confirmado.

Arquivos criados/modificados nesta tarefa:

- `.github/workflows/ci.yml`
- `ARCHITECTURE.md`
- `README.md`
- `docs/02_ADR_REGISTER.md`
- `docs/14_PROGRESS.md`
- `docs/API.md`
- `docs/OPEN_ISSUES.md`
- `docs/REQUIREMENTS_TRACEABILITY.md`
- `docs/TESTING.md`
- `docs/adr/019-provider-resource-authorization.md`
- `docs/adr/README.md`
- `scripts/test-suite-runner.ts`
- `src/app.module.ts`
- `src/application/authorization/authorization-store.ts`
- `src/application/authorization/resource-authorization.ts`
- `src/infrastructure/database/migrations/.snapshot-jungle.json`
- `src/infrastructure/database/migrations/Migration20261116120000.ts`
- `src/infrastructure/database/mikro-orm.config.ts`
- `src/infrastructure/database/mikro-orm/authorization.entities.ts`
- `src/interfaces/http/app.controller.ts`
- `src/interfaces/http/oidc-jwt.verifier.ts`
- `src/interfaces/http/provider-identity.guard.ts`
- `src/interfaces/http/resource-authorization.interceptor.ts`
- `src/interfaces/http/wallet.controller.ts`
- `test/integration/authorization-persistence.spec.ts`
- `test/integration/provider-authorization-audit.spec.ts`
- `test/unit/provider-identity.guard.spec.ts`

## 2026-11-16 — Tarefa 3: autorização financeira HTTP

Worktree `/workspace/jungle-auth-financial`, branch
`security/financial-endpoint-authorization`, baseada em `a989e74` (Tarefa 2).
`origin/main` novamente consultada por fetch: `b4c0bad`; checkouts anteriores limpos.
`AuthorizeResource` une guard JWT e política; resposta 401 padronizada para ausência
de principal. Fixture HTTP compartilhável com criptografia/JWKS, Nest e PG reais.
Quatro testes adicionais exercitam todos os endpoints/tipos financeiros, dois
providers, recursos exclusivos/compartilhados, falta de grants, issuer/sub divergente,
disputa de saldo, 12 replays concorrentes e requisição bloqueada durante revogação
observada no PostgreSQL. Regras financeiras, domínio e migrations inalterados.
Arquivos: decorator/interceptor, ResourceAuthorization, controllers App/Wallet,
runner, `test/helpers/oidc-http-fixture.ts`, novo spec financeiro, ADR-019 e TESTING.
Typecheck/lint/format/build passaram; teste focado: 4 pass, 0 fail.
Regressão final da Tarefa 3: 104 testes em 15 targets, 0 falhas/erros/skips;
PostgreSQL e LocalStack reais, migrations sem pendências. Sem push/merge ou CI
remoto confirmado; branch mantida separada para revisão.

## 2026-11-16 — Tarefa 4: papéis administrativos e métricas

Worktree `/workspace/jungle-auth-admin`, branch `security/administrative-role-access`,
baseada no commit da Tarefa 3 `6b13ad4`. `origin/main` permanece na referência
consultada `b4c0bad`; checkouts anteriores preservados. Código combinado desta branch
inclui as Tarefas 1–4, ainda sem push/merge na main e sem CI remoto confirmado.

Política mínima: provider comum não ganha operações administrativas; operador/admin
precisam de papel configurado e permission exata no JWT RS256/JWKS validado, além
do grant PostgreSQL da ação por issuer/subject. Nem admin tem bypass de scope ou
grants. Consulta/resolução são independentes; claims e nomes de papéis são
configuráveis e configurações inválidas falham fechadas. Quarentena mantém a
delegação global explicitamente definida na ADR, sem inferir provider de raw JSON.
Um papel válido sem grant não permite alterar mensagens de outros providers.

AdministrativeClaimsPolicy é reutilizada para quarentena e MetricsAccessGuard.
Métricas em OIDC exigem papel operacional e scope assinado metrics:read, sem query
adicional ao banco (observabilidade global delegada no IdP). Challenge dev/test
continua público por compatibilidade; challenge production é desabilitado por
padrão. Public em OIDC/production ou configuração inválida falha fechada. Health
permanece público. Operação externa deve usar OIDC/produção e rede restrita.

Auditoria da quarentena registra ator autenticado e decisão; resolução e decisão
allow participam do mesmo commit. Logs redigidos emitem eventos allow/deny e
correlação, sem tokens, claims, raw payload ou notas. Métricas registram decisão
em log, sem depender da auditoria SQL para scrape.

Validação local final (Bun 1.1.38, Node 24.22.1, Docker Engine/Compose, PostgreSQL 16
/ LocalStack 3.8 reais; Docker Desktop local não confirmado):

- typecheck, lint, format:check e build passaram.
- Focado administrativo: 5 casos HTTP, 0 falhas; mais 3 testes unitários de política.
- test:all: **112 testes, 16 targets, zero falhas/erros/skips**, incluindo os testes
  financeiros e concorrência da Tarefa 3, PG/SQS reais e rollback legado da Tarefa 2.
- Migrations sem pendências e Compose válido; nenhuma migration nova nesta tarefa.
- Logs de requisições reais capturados com JsonLogger: evento administrativo
  presente, sem JWT, Bearer, permissions, nota privada ou raw payload sensível.
- Sem alteração de domínio, algoritmos financeiros ou migrations históricas.
- Smoke de reinício do container não executado; Dockerfile/Compose não alterados.

Pendências operacionais: mapear claims no IdP e aprovar grants administrativos,
configurar coletor de métricas com JWT/escopo, separar credenciais/retencão em
produção. Sem autoatribuição de privilégios ou interface administrativa nova.
A delegação operacional atual é global; isolamento por tenant/fila requer outra
política com origem confiável. A permissão de métricas segue validade do JWT, não
revogação imediata em banco. Nenhuma integração na main sem CI confirmado.

Arquivos criados/modificados na Tarefa 4:

- `.env.example`
- `ARCHITECTURE.md`
- `README.md`
- `docs/14_PROGRESS.md`
- `docs/ADMINISTRATIVE_ACCESS.md`
- `docs/API.md`
- `docs/OPEN_ISSUES.md`
- `docs/REQUIREMENTS_TRACEABILITY.md`
- `docs/TESTING.md`
- `docs/adr/019-provider-resource-authorization.md`
- `scripts/test-suite-runner.ts`
- `src/app.module.ts`
- `src/application/authorization/administrative-claims-policy.ts`
- `src/application/authorization/resource-authorization.ts`
- `src/interfaces/http/app.controller.ts`
- `src/interfaces/http/metrics-access.guard.ts`
- `src/interfaces/http/resource-authorization.interceptor.ts`
- `test/helpers/oidc-http-fixture.ts`
- `test/integration/administrative-role-access.spec.ts`
- `test/integration/provider-authorization-audit.spec.ts`
- `test/unit/administrative-claims-policy.spec.ts`

## 2026-11-16 — Preparação operacional do rollout OIDC

Branch `ops/oidc-rollout`, worktree `/workspace/jungle-oidc-rollout`, base `4843ee5`.
Após inspeção do repositório e metadata do runtime, não há issuer/realm/cliente,
IdP administrativo ou coletor configurados, nem subjects aprovados conhecidos.
Pergunta de esclarecimento enviada; nenhuma identidade ou privilégio de produção
foi inventado/aplicado. Credenciais não foram solicitadas em chat.

Implementados `scripts/oidc-rollout.ts`, plano de exemplo em `infra/rollout`, guia
`docs/OIDC_ROLLOUT.md`, link em ADMINISTRATIVE_ACCESS e specs de validação/PG real.
Sem --apply, ferramenta apenas gera arquivos de revisão privados, sem conexão SQL.
Aplicação exige plano explícito, alvo DB exatamente igual ao ambiente e não aceita
placeholders de exemplo. Grants são explícitos, atômicos e idempotentes, sem afetar
finanças/wallets; actor é atribuição administrativa do canal confiável. Conexão SQL
production deste script verifica certificado TLS, com CA opcional por arquivo.

Configuração candidata do coletor usa OAuth2 client credentials, scope metrics:read
e secret por arquivo, sem valores secretos. api-environment.json mantém OIDC e
métricas autenticadas. Configuração do IdP/serviço de coleta depende do destino real.

Validação: typecheck/lint/format/build passaram; suíte completa com **117 testes,
17 targets, zero falhas/erros/skips**, PostgreSQL/LocalStack reais. Casos novos
validam plano seguro, ausência de inline secrets, escopo explícito, idempotência e
rollback de lote em falha de trigger PostgreSQL. Geração dry-run executada.
Configuração candidata passou em `promtool check config --syntax-only` com
Prometheus v3.2.1, preservando permissões 0600 (container executado como UID do arquivo).
Isso não comprova autenticação no IdP ou scrape real, que permanecem pendentes.

Arquivos: scripts/oidc-rollout.ts, scripts/test-suite-runner.ts,
infra/rollout/plan.example.json, test/unit/oidc-rollout.spec.ts,
test/integration/oidc-rollout.spec.ts, docs/OIDC_ROLLOUT.md,
docs/ADMINISTRATIVE_ACCESS.md e este progresso.
Sem deploy, push, merge ou confirmação de CI remoto. Continuar o rollout após
identificação do IdP/cliente/audience, subjects aprovados e coletor, com acesso
administrativo e credenciais fornecidos pelos canais seguros.

## 2026-11-16 — Tarefa 5: hardening OIDC/JWT

Worktree jungle-oidc-hardening, branch security/oidc-hardening, base 8bed00d.
origin/main confirmada por fetch em b4c0bad; trabalho anterior preservado.
Verificador RS256/JWKS e guard mantidos, com validação de startup, issuer exato,
URL/DNS/IP pinning, redirects bloqueados, limites de token/resposta/chaves,
claims/algoritmos estritos, TTL/rotação atomicamente substituídos, coalescência e
cooldown de refresh. Configuração imutável por instância; alteração exige restart.
Timeout encerra socket explicitamente no Bun. HTTP loopback apenas por opt-in em
test/development, ignorado em production. Nenhuma regra financeira/migration alterada.
Testes usam IdP local real com JWKS rotativo e cenários adversariais; guard não usa
mais mock global de fetch. Parâmetros e limites em OIDC_HARDENING.md.
Validação final Tarefa 5: typecheck/lint/format/build passaram; **123 testes,
17 targets, 0 falhas/erros/skips**, incluindo assinatura/claims, rotação new/same kid,
discovery/redirect/malformed JWKS e timeout reais. Sem push/merge ou CI remoto.

## 2026-11-16 — Tarefa 6: gestão durável de quarentena

Worktree jungle-quarantine, branch reliability/quarantine-management, base dec7f8e.
Consulta paginada/filtros, histórico e redrive manual com RBAC específico,
justificativa, tentativa idempotente persistida e lease de 60s decidido no PG.
SQL claim precede publicação; resultado incerto mantém PENDING/REDRIVING e pode ser
retomado com mesma key/UUID após lease. Fencing de lease_token impede overwrite de
worker antigo. At-least-once preserva IDs financeiros/Inbox; não corrige payload.
Resolução é disposição separada, bloqueada durante REDRIVING, com evento append-only.
Auditoria retém ator/horário/justificativa/resultado mesmo após reabertura posterior.
Migration aditiva 130000 preserva finanças e amplia status/permissão operacional;
rollback exige recuperação/backup. Snapshot antigo comparado estruturalmente e
preservado; novos objetos registrados no MikroORM. CI inclui backup das tabelas novas.
Validação: typecheck/lint/format/build passaram; **130 testes, 19 targets,
zero falhas/erros/skips**. PostgreSQL/LocalStack reais, triggers para falhas reais de
banco, redrive simultâneo, duplicata sem novo débito e processo Node independente
para recuperação pós-envio. Teste de migration preserva disposições legadas e
auditoria no up/down/up. Testes usam base isolada e bancos descartáveis próprios.
Limites: publicação não é exactly-once nem prova sucesso financeiro; malformados
exigem correção legítima na origem; histórico HTTP limita últimas 100 entradas,
com auditoria integral no PG. Sem push/merge/CI remoto confirmado.
Revisão do snapshot da Tarefa 6: introspecção PG mudou também o rótulo de coluna
associado a CHECKs multicoluna, sem alterar suas expressões. O snapshot foi atualizado
somente para status/permissão ampliados, índice de paginação e duas tabelas novas;
entradas financeiras anteriores preservadas integralmente. Sem novo SQL/DDL.

## 2026-11-16 — Tarefa 7: processo real interrompido entre commit e ACK

Worktree jungle-inbox-recovery, branch test/inbox-commit-ack-recovery. Contém os
commits das Tarefas 1–6 e ajustes de hardening IPv6/discovery vazio. Teste novo usa
pollLoop/handleMessage reais, subclass de teste apenas no limite de ACK e SIGKILL
real do processo filho. Pai confirma commit por outra conexão; novo processo com
novo ORM consome a mesma mensagem após visibilidade expirar e confirma ACK real.
Wallet, transação, Inbox, ledger e Outbox permanecem idênticos ao snapshot anterior.

Não há toggle de pausa em produção. Fixture fora de src/dist exige alvos locais,
run/database/queue exatos, NODE_ENV=test e dummy credentials; test/ é excluído do
contexto Docker. Exportação real do contexto com Docker confirmou ausência de test/.
Dockerfile preserva frozen lockfile com concorrência de download limitada a 1.

Artefato .test-results/inbox-commit-ack-evidence.json registra SIGKILL, PIDs distintos,
receive count 1→2, saldo 75.00/version 2, uma BET/Inbox, dois lançamentos e ACK.
Registra baseCommit, dirty e hashes dos fontes para não fingir execução em SHA limpo.
Target está em all/sqs/recovery e no test:all do CI, com upload dos artefatos.

O build integral da imagem neste runtime ficou pendente na instalação Bun. Houve
SELF_SIGNED_CERT_IN_CHAIN no probe inicial; montando a CA oficial de sessão como
secret (orientação cloud-environment-runtime) o probe registry retornou 200, sem
desativar TLS. A instalação no build continuou sem progresso e foi interrompida;
nenhuma imagem completa é declarada validada. Contexto Docker e ausência do fixture
foram verificados separadamente, sem etapa de instalação/rede. TypeScript e o teste
real de crash não dependem desse build. CI remoto ainda precisa ser confirmado.
Validação final combinada Tarefas 5–7: typecheck/lint/format/build passaram;
**131 testes em 20 targets, 0 falhas/erros/skips**, PG/LocalStack reais. A última
regressão reproduziu e corrigiu inversão de locks entre claim/finalização; teste
agora usa quatro redrives simultâneos e mantém apenas 201/409 como resultados válidos.
Hardening final inclui IPv6 comprimido reservado e JWKS_URI vazio preservando
discovery validado. Não houve alteração de Money ou regras financeiras.

Após solicitação de visibilidade no GitHub, branches das tarefas 5 e 6 foram
publicadas com git push normal, sem force e sem alteração da main. Branch consolidada
da Tarefa 7 será publicada após este commit. API de consulta ao Actions retornou
CONNECT 403 do proxy; não se presume aprovação do CI. Os runs podem ser consultados
na interface GitHub das branches. Evidência local de crash mantém hash dos fontes
exercitados e sinal/processos reais; imagem completa permanece pendente como descrito.

## 2026-11-16 — Tarefa 8

Branch test/outbox-publish-recovery: publisher independente sofre SIGKILL após
recepção confirmada no SQS e antes de published_at. Recuperação após lease real,
mesmo eventId, attempts=2 e snapshot de wallet/ledger invariável. At-least-once;
FIFO pode suprimir o segundo envio na janela de dedup. Evidência JSON em test-results.
Typecheck/lint/format/build passaram; suíte: 132 testes/21 targets, zero falhas/skips.
Runner all/sqs/recovery inclui o cenário e o CI existente executa/upload do target.

## 2026-11-16 — Tarefa 9

Exemplo isolado em examples/event-consumer: projeção didática e processed IDs no
mesmo commit PG; ACK posterior, invalid input auditado, falhas SQL sem ACK,
concorrência entre conexões e SIGKILL real pós-commit. Banco exclusivo do teste,
sem alteração de saldo/ledger principal. 135 testes/22 targets passaram, sem skips;
typecheck/lint/format/build passaram. Sem exactly-once fim a fim: efeitos externos
exigem Outbox própria. Conflitos de payload seguem retry/DLQ configurado no broker.

## 2026-11-16 — Tarefa 10

Profile opcional Prometheus/Grafana, dashboard provisionado e seis alertas.
Amostrador SQL opcional preserva /metrics em memória e labels limitadas. Override
OIDC usa OAuth2 sem bypass de guard. Promtool validado; serviços HTTP200, dashboard
provisionado e scrape up=1 reais. 136 testes/23 targets, zero skips/falhas;
typecheck/lint/format/build aprovados. Sem Alertmanager/entrega externa configurada.

## 2026-11-16 — Tarefa 11

Suíte k6 separada em Compose descartável,5cenários HTTP, lote SQS real e validação
SQL/HTTP posterior. 31wallets reconciliadas,20Inbox,424eventos publicados; checks
aprovados. Relatório e summaries reais versionados, sem extrapolar ensaio curto
de4VUs para produção. Suíte funcional136/23targets sem skips; qualidade aprovada.

## 2026-11-16 — Tarefa 12

Terraform modular network/data/runtime: ECS privado, ALB TLS, RDS criptografado,
SQS FIFO/DLQ, IAM específico, secrets por ARN, autoscaling e rollback. Terraform
1.10.5/provider AWS 5.100.0: fmt/init backend=false/validate aprovados; sem plan,
apply ou recursos pagos. Testes reproduziram TLS sem validação e endpoint SQS
local forçado; correções usam CA confiável e SDK credential chain no ECS.
Typecheck/lint/format/build e 139 testes em 23 targets passaram, zero skips.
Bootstrap DB/roles, migrações privadas, DNS/ACM/IdP, restore e operação AWS exigem
conta isolada autorizada; não há alegação de produção validada.

## 2026-11-16 — Galeria de execução real

Branch docs/system-gallery em worktree próprio. Cinco imagens no README: Grafana
e Prometheus capturados diretamente; relatórios identificados para HTTP/SQL,
deduplicação SQS/PostgreSQL e CI público aprovado no SHA 0039db9. Código financeiro
inalterado. Demonstração isolada: saldo75.00 após BET25.00, cinco replays, uma BET
e dois lançamentos; reconciliação consistente. Duas mensagens SQS distintas e
dois consumidores produziram uma projeção persistida, sem alterar wallet/ledger.
Amostras reais de tráfego e consulta up=1 gravadas, com hashes e reprodução.
Capturas inspecionadas visualmente. Checks de qualidade e typecheck dos scripts
aprovados; scripts de captura executados com PostgreSQL/LocalStack reais.
CSS externo do GitHub bloqueado: imagem de CI é relatório de metadados verificáveis,
explicitamente identificada, sem imitar a UI. Não é benchmark nem prova de OIDC.

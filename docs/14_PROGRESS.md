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

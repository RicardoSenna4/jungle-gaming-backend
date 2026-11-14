# Discovery técnico — Jungle Gaming Backend Challenge

**Data:** 2026-11-13
**Escopo:** análise do README oficial, kit de orientação e workspace atual.
**Status da fase:** CONCLUÍDA — análise בלבד; nenhum código foi implementado ou alterado nesta tarefa.

## 1. Fontes e estado observado

A fonte normativa é o `CHALLENGE_SPEC.md`, cópia do README oficial original. O clone remoto `https://github.com/junglegaming/backend-challenge` foi verificado na branch `main`; o repositório de origem contém apenas o README do desafio. O kit fornecido foi lido em `AGENTS.md`, `START_HERE.md`, `MANUS_PROJECT_INSTRUCTIONS.md`, `docs/00_SOURCE_OF_TRUTH.md` até `docs/18_OPERATING_POLICIES.md`, incluindo matriz de requisitos, domínio, schema, API/eventos, falhas, fases, segurança e gates.

O workspace atual possui uma implementação não commitada anterior (`src/`, `test/`, `package.json`, migration e documentação operacional). Essa implementação é evidência de estado do workspace, não evidência de atendimento do desafio completo. O `git status` observado foi `main...origin/main`, com `README.md` modificado e os arquivos da implementação como não rastreados. Não existe commit desta entrega no workspace.

## 2. Resumo executivo

O desafio avalia um processador financeiro distribuído, não um CRUD. O centro da solução é manter a equivalência entre saldo materializado e ledger append-only sob duplicatas, concorrência, mensagens fora de ordem, crash entre commit e ACK/publicação e indisponibilidade temporária de PostgreSQL/SQS.

As maiores áreas de risco e pontuação são:

1. correção financeira e invariantes do saldo/ledger — 20 pontos;
2. concorrência entre instâncias e ausência de lost update — 20 pontos;
3. idempotência persistente e replay — 15 pontos;
4. SQS, inbox, outbox, retry, DLQ e recuperação — 15 pontos.

Esses quatro blocos somam 70 pontos e contêm todas as falhas eliminatórias. Autenticação não pontua; pode ser omitida, desde que a decisão e o ponto de extensão para IdP externo sejam documentados.

## 3. Requisitos obrigatórios

### 3.1 Stack e infraestrutura

- Runtime, package manager e test runner: Bun 1.x.
- Linguagem: TypeScript strict.
- Framework: NestJS.
- Banco: PostgreSQL.
- Mensageria: AWS SQS via LocalStack ou MiniStack.
- Orquestração: Docker Compose.
- Migrations versionadas e reversíveis.
- ORM permitido: MikroORM, preferencial, ou TypeORM. Prisma e outros ORMs são proibidos.
- Serviços precisam funcionar com múltiplas instâncias reais, não apenas várias promises no mesmo processo.

### 3.2 Regras financeiras e de domínio

- `Money` recebe e serializa montante como string decimal de exatamente duas casas, com currency ISO-4217.
- Entrada externa não pode ser número JavaScript, notação científica, `NaN`, `Infinity`, string vazia, vírgula, mais de duas casas ou negativo.
- Operações monetárias são exatas, imutáveis e rejeitam moedas diferentes.
- Entidades de domínio usam construtor privado/protected, factories estáticas e `rehydrate`; o domínio não depende de decorators Nest/ORM.
- Uma wallet é única por `(playerId, currency)`.
- Saldo nunca pode ser negativo, inclusive durante reversões.
- `version` começa em 1 e só aumenta quando o saldo muda.
- Toda alteração de saldo tem exatamente um lançamento correspondente na mesma transação SQL.
- `OPENING` é apenas interna; abertura com saldo positivo cria wallet, transação e ledger atomicamente. Saldo inicial zero não cria movimento.
- `BET` debita e rejeita por insuficiência sem alterar saldo/ledger.
- `WIN` credita; referência a BET pode ser opcional, conforme decisão documentada.
- `LOSS` é processada sem movimento, ledger ou incremento de versão.
- `REFUND` credita apenas BET processada, no mesmo contexto, com valor integral e sem duplicidade.
- `ROLLBACK` inverte BET, WIN ou REFUND processada, também integralmente; pode ser rejeitada por insuficiência ao inverter crédito.
- Referências são resolvidas por `(providerId, referenceExternalTransactionId)` e precisam coincidir em provider, player, wallet, moeda e rodada.
- `PROCESSED`, `REJECTED` e `FAILED` são estados terminais.
- Rejeições são auditáveis, possuem `failureCode` estável e não criam ledger.

### 3.3 Idempotência

- `Idempotency-Key` é obrigatória no HTTP e é a fonte persistente da verdade.
- A mesma key com o mesmo payload não pode movimentar saldo novamente.
- Replay deve retornar o snapshot do saldo observado no processamento original, mesmo após novas operações.
- A mesma key com payload de negócio diferente retorna conflito, sem novo efeito.
- O hash é SHA-256 de JSON canônico, com chaves ordenadas recursivamente e subconjunto de campos de negócio fixo; header, messageId e metadados de transporte não entram.
- `externalTransactionId`, idempotency key e `messageId` são identificadores distintos e precisam de proteções distintas.

### 3.4 Persistência e consistência

- Wallet, transação, ledger, inbox e outbox participam da mesma transação PostgreSQL quando aplicável.
- O ledger é append-only também no banco: UPDATE e DELETE devem falhar por trigger/permissão.
- Schema deve conter unicidade, checks, foreign keys, limites monetários e índices adequados.
- Saldo derivado da soma do ledger deve ser comparável ao saldo armazenado; divergência gera sinalização, nunca autocorreção silenciosa.
- Migrations precisam ter `up` e `down` verificáveis em PostgreSQL descartável.

### 3.5 API HTTP obrigatória

| Método e rota | Resultado exigido |
|---|---|
| `POST /wallets` | cria wallet; saldo positivo gera OPENING + ledger atômicos |
| `GET /wallets/:walletId` | saldo string, moeda e versão |
| `GET /wallets/:walletId/ledger?cursor=&limit=` | cursor opaco, estável e ordenação determinística |
| `GET /wagering/transactions/:transactionId` | status e failureCode quando aplicável |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | consulta por identidade externa |
| `POST /wagering/transactions` | processa ou aceita operação; Idempotency-Key obrigatório |
| `POST /wallets/:walletId/reconciliation` | compara saldo/ledger, sem autocorreção |
| `GET /health/live` | processo vivo, aberto |
| `GET /health/ready` | PostgreSQL e SQS alcançáveis, aberto |

O código HTTP precisa distinguir payload inválido, conflito de idempotência, rejeição de domínio, aceitação pendente e falha transitória de infraestrutura. O kit propõe 400/409/422/202/503, mas a escolha final precisa ser consistente e documentada.

### 3.6 SQS, inbox e outbox

- Fila de comandos FIFO `wager-transactions.fifo` e DLQ `wager-transactions-dlq.fifo`.
- Consumer valida envelope e `messageId`, grava inbox por `(consumerName, messageId)` e reutiliza o mesmo use case do HTTP.
- ACK ocorre somente depois do commit SQL.
- Falha de negócio terminal faz ACK; falha transitória não faz ACK e permite retry/redrive; payload permanentemente inválido segue política explícita de DLQ/quarentena.
- SIGTERM interrompe polling e drena mensagens ou permite redelivery seguro.
- Outbox é escrita na transação financeira e publicada somente após commit.
- Publisher concorrente usa lease/claim e `SKIP LOCKED` ou mecanismo equivalente, retry com backoff e recuperação após crash.
- Publicação exatamente uma vez não é garantível; duplicatas após publish antes de `publishedAt` precisam ser toleradas pelo consumidor.
- Eventos de saída devem ter roteamento distinto da fila de comandos, salvo ADR explícita contra loops.

### 3.7 Eventos obrigatórios

- `WagerTransactionProcessed`, inclusive `LOSS`.
- `WagerTransactionRejected`.
- `WagerTransactionPendingReference`.
- `WalletBalanceChanged` somente quando o saldo muda, incluindo OPENING positivo.

Cada evento deve ser uma subclasse concreta de envelope abstrato versionado, com `eventId`, `eventType`, `aggregateId`, `correlationId`, `causationId` opcional, `occurredAt`, `version` e `data`. `Money` em payload é `MoneyProps` com string, nunca instância ou número.

### 3.8 Observabilidade e documentação

- Logs JSON estruturados com correlationId, messageId, transactionId, walletId e providerId.
- Não registrar payload financeiro completo, secrets ou dados sensíveis.
- Métricas de status, duplicatas, retries, DLQ, conflitos de lock, outbox lag e latência.
- README final executável, `ARCHITECTURE.md` honesto, enunciado preservado, Compose e comandos reproduzíveis.

## 4. Requisitos opcionais ou não pontuados

- Autenticação: opcional e sem pontos; se feita, deve integrar IdP externo, não tabela própria de usuários/senhas. Se omitida, documentar guard/ponto de extensão e não expor a API aberta como produção.
- OpenTelemetry e dashboard: opcionais.
- Double-entry bookkeeping: diferencial opcional; ledger de uma entrada por wallet/transação é suficiente.
- Teste de carga: opcional e só deve ser incluído com metodologia, ambiente, p50/p95/p99, erros, locks e outbox lag honestamente medidos.
- Microserviços, Kubernetes, Redis, Kafka e frontend: não são necessários e aumentam superfície de falha.

## 5. Invariantes financeiros inegociáveis

1. `wallet.balance >= 0` no domínio e no PostgreSQL.
2. `wallet.balance == SUM(credits) - SUM(debits)` do ledger no mesmo snapshot de leitura.
3. Nenhuma transação financeira produz mais de um ledger por wallet.
4. Nenhum `LOSS` ou rejeição produz ledger.
5. Toda mudança de saldo e seu ledger confirmam ou desfazem juntos.
6. Nenhuma duplicata de key, external transaction ou inbox gera novo efeito.
7. Duas apostas concorrentes disputando 100 com 80 resultam em exatamente uma processada, uma rejeitada, saldo 20 e um débito.
8. Reversões não podem gerar saldo negativo nem duplicar crédito.
9. Locks são por wallet no banco; não há mutex global ou garantia baseada apenas em FIFO.
10. Evento confirmado não é perdido por falha posterior de SQS; fica durável na outbox.

## 6. Matriz de rastreabilidade consolidada

| ID | Requisito | Categoria | Prioridade | Evidência obrigatória | Estado observado |
|---|---|---|---|---|---|
| R01 | Bun, Nest, TS strict, PostgreSQL, SQS emulator, Compose | Infra | P0 | boot/Compose real | BLOCKED: Bun/Docker ausentes |
| R02 | ORM permitido e migrations up/down | Infra | P0 | PostgreSQL descartável | NOT_VERIFIED |
| R03 | Money string exato, escala 2, validação | Domínio | P0 | U01-U04 | PARCIAL: testes unitários locais existentes |
| R04 | Factories/rehydrate, domínio isolado | Domínio | P0 | inspeção + testes | PARCIAL |
| R05 | wallet única e versionamento | Domínio/SQL | P0 | I02/C14 | NOT_VERIFIED em DB real |
| R06 | saldo não negativo e sem lost update | Financeiro/concorrência | P0 | I03/C02/C03 | NOT_VERIFIED |
| R07 | OPENING atômica | Financeiro/SQL | P0 | I05 | NOT_VERIFIED |
| R08 | BET debit/rejeição | Domínio | P0 | U06/C02 | PARCIAL: unidade, sem integração |
| R09 | WIN/Loss | Domínio | P0 | U07 + integração | PARCIAL |
| R10 | REFUND integral, mesma referência, uma vez | Domínio | P0 | U08/I12/C10 | INCOMPLETO |
| R11 | ROLLBACK e insuficiência específica | Domínio | P0 | U09/C10 | INCOMPLETO |
| R12 | contexto provider/player/wallet/currency/round | Domínio | P0 | I19 | INCOMPLETO |
| R13 | pending reference, backoff, TTL | Distribuído | P0 | I12/C09 | AUSENTE |
| R14 | estados terminais imutáveis | Domínio/SQL | P0 | U10/I20 | PARCIAL |
| R15 | ledger append-only e único | SQL | P0 | I04 + trigger real | PARCIAL: migration não executada |
| R16 | reconciliação sem autocorreção | Financeiro | P0 | I15 | AUSENTE |
| R17 | key persistente e replay original | Idempotência | P0 | I07/I17/C01 | PARCIAL: sem DB/concurrency real |
| R18 | conflito por payload/hash canônico | Idempotência | P0 | U12/I08 | PARCIAL: hash unitário |
| R19 | API completa e códigos distintos | HTTP | P0 | HTTP/integration | INCOMPLETO |
| R20 | FIFO, DLQ, inbox e use case comum | Mensageria | P0 | I09-I11 | AUSENTE |
| R21 | ACK pós-commit, retry/DLQ/SIGTERM | Mensageria | P0 | I11/C05/C12 | AUSENTE |
| R22 | inbox + financeiro + outbox atômicos | Consistência | P0 | I06/I13 | INCOMPLETO |
| R23 | publisher concorrente, retry, recovery | Mensageria | P0 | C06-C08 | AUSENTE |
| R24 | eventos concretos e envelope versionado | Eventos | P0 | I18 | INCOMPLETO |
| R25 | duas BET 80 contra 100 | Concorrência | P0 | C02 real | NOT_VERIFIED |
| R26 | mesma BET x50, 3 instâncias | Concorrência | P0 | C01/C03 real | NOT_VERIFIED |
| R27 | reversões fora de ordem/restart | Distribuído | P0 | C09-C11 | AUSENTE |
| R28 | logs e métricas | Observabilidade | P1 | inspeção/endpoint | AUSENTE |
| R29 | live/ready real | Infra | P1 | I14 | PARCIAL: live simples |
| R30 | README/ARCHITECTURE executáveis | Entrega | P1 | terceiro reproduz | PARCIAL |
| R31 | auth externa ou decisão de omissão | Segurança | P1 | ADR/extensão | DECISÃO de omissão documentada |
| R32 | integração real PG/SQS/recovery | Testes | P0 | I/C completos | BLOCKED pelo ambiente |
| R33 | sem locks globais/FIFO-only/ORM proibido | Auditoria | P0 | revisão de código | PARCIAL |
| R34 | failureCode e classificação consistente | Contrato | P0 | U13/HTTP/SQS | INCOMPLETO |

## 7. Ambiguidades que exigem ADR antes de implementação

| ID | Questão | Risco | Recomendação para decisão |
|---|---|---|---|
| A01 | REFUND + ROLLBACK da mesma BET | crédito econômico duplo | política conservadora: uma reversão econômica direta por referência; permitir rollback de refund somente se modelado sem duplicidade |
| A02 | WIN sem BET | crédito sem aposta | permitir, pois README diz que referência pode existir; documentar que referência é opcional |
| A03 | amount de LOSS | contrato inconsistente | exigir valor positivo no DTO, mas não gerar efeito; rejeitar zero/negativo |
| A04 | referência existente mas não processada | ordem temporal | manter PENDING_REFERENCE enquanto recuperável; rejeitar referência terminal inválida |
| A05 | ordem de locks | deadlock | fixar ordem determinística: idempotência/referência e depois wallet, ou desenho equivalente testado |
| A06/A07 | colisões entre external ID e key | fraude/replay | constraints únicas e conflitos explícitos |
| A08 | replay de pending após processamento | semântica API | persistir snapshot inicial e expor status atual de forma distinta, decisão formal necessária |
| A09 | wallet de outro player | crédito indevido | rejeição sem ledger e failureCode de contexto |
| A10 | DB commit sem resposta HTTP | retry | snapshot persistente por key |
| A11 | FAILED após retries | auditoria | definir limite e diferença entre infra transitória, permanente e DLQ |
| A12 | readiness SQS | falso positivo | usar chamada real de health/queue configurada |
| A13 | fila de eventos | loop | separar fila de comandos e eventos |
| A14 | OPENING zero | version/ledger | version 1, sem ledger |
| A15 | limite NUMERIC | overflow | validar limite no domínio e no schema |
| A16 | códigos HTTP de moeda/conflito | integração | catálogo estável e testes de contrato |

## 8. Falhas e recuperação exigidas

- Crash antes do SQL: mensagem deve ser reentregue.
- Crash depois de ledger mas antes de commit: rollback integral, sem órfãos.
- Crash depois de commit e antes de ACK: redelivery sem segundo débito por inbox/idempotência.
- PostgreSQL indisponível: não confirmar efeito parcial; retry sem transformar automaticamente em rejeição.
- SQS indisponível depois do commit: outbox pendente e retry posterior.
- Publisher morre depois de publicar antes de marcar: evento pode duplicar, mesmo `eventId`; consumidor deduplica.
- Dois publishers concorrentes: claim/lease sem publicação infinita.
- Referência chega depois: pending worker com backoff/TTL e rejeição auditável no vencimento.
- SIGTERM em mensagem in-flight: parar polling, drenar ou deixar invisibilidade expirar; nunca ACK prematuro.
- Hot wallet em três processos: lock por row no PostgreSQL e invariantes finais preservadas.

## 9. Falhas eliminatórias

1. usar `number`, `float` ou `double` para dinheiro;
2. permitir saldo negativo por race, inclusive rollback;
3. duplicar débito ou crédito;
4. idempotência somente em memória;
5. funcionamento correto apenas em processo único;
6. publicar evento antes do commit;
7. ausência de ledger auditável/append-only;
8. substituir PostgreSQL/SQS/concorrência real completamente por mocks;
9. tratar FIFO como garantia final de consistência;
10. alterar ou apagar o enunciado sem preservar `CHALLENGE_SPEC.md`.

## 10. Plano recomendado após aprovação da discovery

1. Fundação verificável: Bun, Nest, Compose com PostgreSQL + LocalStack/MiniStack, scripts e health.
2. Domínio e SQL: Money, Wallet, estados, ledger, OPENING, constraints e migrations; executar U01-U11/I01-I05.
3. Use case HTTP: locking, idempotência, hash, snapshot e API; bloquear avanço se C01/C02 falhar.
4. Reversões e pending reference com ADR-013 aprovada.
5. Inbox/SQS real, DLQ, retry e shutdown.
6. Outbox real, eventos concretos, claim e retry.
7. Três instâncias, reconciliação, paginação e recovery.
8. Observabilidade, security review, CI e entrega.

Nenhuma etapa posterior deve ser iniciada sem autorização explícita e sem atualizar progresso com comando, exit code, ambiente e escopo.

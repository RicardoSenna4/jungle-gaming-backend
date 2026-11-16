# ADR-019 — Autorização por identidade e vínculos persistentes

Data: 2026-11-16. Estado: **ADOTADA — associações persistentes e enforcement HTTP implementados na Tarefa 2**.
O diagnóstico e as evidências da Tarefa 1 abaixo descrevem a base histórica.
A Tarefa 2 adiciona persistência, enforcement HTTP e testes negativos; ver a seção
"Implementação da Tarefa 2". Regras financeiras e as cinco migrations históricas foram preservadas.
Base inspecionada: `origin/main` em `b4c0bad713ba33a343b2727e3613853f1cd06591`,
confirmada por `git fetch origin main`. Resultados locais não constituem aprovação do CI.

## Contrato e implementação encontrada

A especificação (§2, §6.2, §7, §9 e §10 de [CHALLENGE_SPEC](../../CHALLENGE_SPEC.md))
permite vários provedores e exige uma wallet global por `(playerId, currency)`.
Não atribui uma wallet exclusivamente a um provider. A referência de uma reversão,
por outro lado, precisa ser do mesmo provider. Portanto não adicionar `owner_provider_id`
à wallet nem alterar sua chave única para incluir provider.

A implementação já possui OIDC/JWT RS256/JWKS, não apenas um guard no-op:
[verifier](../../src/interfaces/http/oidc-jwt.verifier.ts) valida assinatura, issuer,
audience, tempo, subject e claim de provider; o
[guard](../../src/interfaces/http/provider-identity.guard.ts) anexa `request.principal`.
O guard aceita qualquer token válido sem consultar vínculos persistentes. Compara
apenas um provider recebido: **body tem precedência sobre params**. Os controllers
não encaminham o principal aos casos de uso. `AUTH_MODE=challenge` é permissivo
por contrato e permanece assim; não pode ser usado como fronteira de produção.

### Achados e exposição atual em OIDC

| ID | Evidência concreta | Consequência / prioridade |
|---|---|---|
| A1 | `WalletController.get` → `WalletService.getWallet` → `WalletRepository.findById`: busca apenas por UUID | Qualquer provider autenticado que conheça o UUID lê jogador, saldo global e versão; alta |
| A2 | `findLedger` filtra só `wallet_id`; `reconcile` soma todo o ledger dessa wallet | Exposição de movimentos, saldos antes/depois, IDs de transações de outros providers e reconciliação global; alta |
| A3 | `AppController.getTransaction` → `findTransactionById`: somente `{id}` | Leitura de transação alheia, contexto e snapshot original; alta |
| A4 | `getProviderTransaction` consulta corretamente `{providerId, externalTransactionId}`, mas o guard prefere body | No runtime Node suportado, GET com token B, URL A e JSON body `{providerId: B}` atravessa o guard e lê a transação de A; alta |
| A5 | `createWallet` recebe só jogador e saldo; `WalletRepository.create` gera OPENING `__internal__` | Qualquer provider cria para jogador arbitrário com crédito inicial; pode ocupar a unicidade global. Nem playerId nem UUID comprovam consentimento; alta |
| A6 | `process` valida contexto player/moeda sob lock, mas não participação autorizada na wallet | Provider usa a própria identidade para apostar em qualquer wallet conhecida com contexto correto. Histórico de participação não é concessão de acesso; alta |
| A7 | `listQuarantine` usa filtro vazio; `resolveQuarantine` busca consumer/message, sem ator ou papel | Qualquer provider lista metadados globais e resolve mensagens operacionais. Raw payload não é retornado, mas fica persistido sem vínculo confiável; alta |

A4 foi reproduzido em API Nest executada por Node (`start` usa `node dist/main.js`).
No runtime Bun testado, o body GET foi descartado e a tentativa não reproduziu a
leitura (403 com cliente Bun e 400 por tamanho do body com cliente Node). Essa
diferença de transporte não é uma política de autorização; o teste cobre também
o runtime Node suportado e comprova o acesso nesse caminho.

UUID imprevisível reduz descoberta, não autoriza acesso. A1–A7 pressupõem token
válido e identificadores/contexto conhecidos; não demonstram bypass de assinatura.
Health fica público por requisito. Métricas estão públicas na implementação e devem
ficar em rede de observabilidade na produção; sua revisão detalhada é outra tarefa.

### Persistência e canais internos

- `WalletOrmEntity`: jogador/moeda globais; sem vínculo com principal/provider.
- `WagerTransactionOrmEntity`: `provider_id`, wallet/player e duas identidades
  únicas por provider; usar esse provider persistido para autorizar a consulta,
  sem transformar participação anterior em autorização sobre a wallet inteira.
- `LedgerOrmEntity`: wallet/transaction; não possui provider próprio. O join da
  transação permite atribuição, mas saldo antes/depois revela atividade compartilhada.
- Inbox deduplica por consumer/message, não representa autorização. Outbox contém
  dados financeiros e deve ser interna; não há endpoint público dessas entidades.
- `QuarantineOrmEntity`: consumer/message, raw payload e nota, sem identidade do
  resolvedor, provider confiável ou RBAC. Provider extraído de JSON inválido é
  não confiável; o payload pode nem ser JSON. Resolver não significa redrive:
  atualmente altera status/nota/horário, sem republicar a mensagem.
- As cinco migrations atuais criam metadata, tabelas financeiras e constraints,
  pendências/reversões, leases de Outbox e quarentena. Nenhuma cria vínculo de
  autorização, papel de operador ou RLS. FKs e constraints financeiras não são ACL.
- O consumer valida o contrato e opcionalmente `ALLOWED_PROVIDER_IDS`; a allowlist
  global não vincula provider a wallet. SQS é canal interno confiável no desafio.
  Em produção, IAM/ingress confiável deve fornecer contexto de origem antes da fila;
  corpo, message attributes e consumerName escolhidos pelo produtor não provam ator.
  Workers internos precisam de identidade técnica explícita, sem fingir um usuário HTTP.

## Decisão adotada

Manter autenticação e autorização separadas. Em OIDC, derivar principal somente de
JWT validado. Consultar um vínculo **ativo** `(issuer, subject, provider_id)` no banco;
a claim de provider deve coincidir com esse vínculo, não pode criar vínculos.
Claims de roles não concedem permissões operacionais automaticamente. Identidade
`__internal__` e outros identificadores técnicos ficam reservados e nunca são
atribuídos por tokens de provedores. Issuer e subject identificam ator; provider
identifica a organização. Mais de um subject pode atuar por um provider, com
provisionamento administrativo auditado.

Vínculos explícitos e revogáveis:

1. `provider_principal_bindings`: issuer, subject, provider, concessão/revogação e
   origem administrativa. Uma identidade pode ter vínculos aprovados com mais de
   um provider; o token seleciona um vínculo ativo. Não inferir acesso por nome.
2. `provider_wallet_grants`: provider, wallet FK, capability, concessão/revogação.
   Relação muitos-para-muitos. A e B podem ter permissões distintas na mesma wallet.
   Capabilities: `balance.read`, `wager.submit`, `transaction.read_own`,
   `ledger.read_all`, `reconcile`. Negar por padrão, sem wildcard implícito.
3. `provider_player_grants`: provider, player global, moeda, capability; permite
   `wallet.create` e, separadamente, `wallet.opening.credit`. O player vem de cadastro
   confiável/integração administrativa, nunca é autoatribuído pela primeira requisição.
   Como hoje não há tabela de players, esses registros são o cadastro autorizado;
   não inventar uma FK para tabela inexistente. Mapear IDs externos de jogador na
   borda confiável, sem mudar a unicidade global do desafio.
4. `operator_grants`: issuer/subject e ação operacional explícita, independente de
   provider. `quarantine.read` e `quarantine.resolve` são distintas, com escopo global
   concedido apenas ao operador responsável pelo canal compartilhado. Um provider
   autenticado não é operador. Eventual suporte por provider exige origem confiável
   persistida e projeção redigida em contrato separado; não filtrar por raw payload.
5. `authorization_audit`: ator `(issuer,sub)`, provider selecionado quando houver,
   ação, recurso, decisão, origem da concessão/revogação, horário e correlação.
   Auditoria append-only e retenção restrita, sem JWT, credenciais ou raw payload.

Uma transação própria só pode ser lida se seu `provider_id` persistido corresponder
à organização autenticada **e** houver `transaction.read_own` ativo para sua wallet.
Compartilhar wallet não compartilha transações privadas. OPENING é interno: endpoint
por UUID de transação não o expõe a providers; o ledger completo pode incluí-lo
apenas sob `ledger.read_all`. Operador não ganha leitura financeira implicitamente.

**Privacidade em wallet compartilhada:** `balance.read` concede ciência explícita de
saldo global; não prometer isolamento desse saldo. `ledger.read_all` concede ciência
de TODO o histórico e dos IDs associados, inclusive outros providers e OPENING.
É opt-in administrativo, não deriva de `wager.submit` ou de `balance.read`. Reconcile
concede ciência dos totais globais e divergências. Não filtrar o ledger atual por
provider e chamar o resultado de saldo/reconciliação global: isso seria falso e
alteraria o contrato. Um extrato restrito exigiria outro DTO/endpoint, sem saldos
globais; fica fora desta tarefa. O snapshot de replay continua retornando o saldo
original, sob autorização atual de submit, sem recalcular ou modificar finanças.

Aplicar decisão em camada de aplicação **antes** de serializar, consultar snapshots
ou executar efeitos, com contexto de ator obrigatório em entradas externas.
Consultas de transações devem incluir provider do principal no predicado SQL;
wallets precisam de EXISTS de grant ativo. Guards servem para autenticação e
verificação estrutural, não são a única defesa. Verificar **todos** os providerIds
presentes em body e URL independentemente; nunca usar fallback com precedência.
Body/header/query/cursor não podem sobrescrever principal, papel ou grant.

Em mutações, verificar grants e vínculo do principal na mesma transação que aplica
o caso de uso, com locks das linhas de autorização em ordem estável e revogação
usando os mesmos locks: uma operação já autorizada e bloqueada antes da revogação
pode concluir; depois do commit da revogação novas operações são negadas. Leituras
usam decisão e recurso no mesmo snapshot/consulta; não usar cache positivo que
estenda grant revogado. Revalidar permissão **antes** de devolver replay. Grants
não são criados automaticamente por aposta, transação rejeitada, OPENING ou SQS.

Criação: verificar player/moeda e `wallet.create`; se saldo inicial positivo,
exigir adicionalmente `wallet.opening.credit`. Criar wallet, OPENING e grants
iniciais aprovados atomicamente. Não conceder `ledger.read_all` ou papel operacional
por ser criador. Para wallet já existente, provider sem acesso recebe 404 antes de
revelar duplicidade; provider autorizado a conhecer esse player/wallet recebe o
409 do contrato. Em challenge, conservar o 409 global atual. Cadastro de outro
provider numa wallet existente é operação administrativa, não um POST que a recria.

Falhas: token ausente/inválido → 401; mismatch explícito de provider e ação
operacional sem capability → 403; recurso inexistente ou não visível → mesmo 404
sem dados, contagem ou cursor. Grant indisponível/DB indisponível → 503, sem
fallback permissivo. Não reclassificar falta de autorização como erro financeiro.

## Matriz de permissões

Rotas de providers requerem principal OIDC e vínculo ativo com provider. Rotas
operacionais requerem identidade OIDC e grant de operador por issuer/subject;
o verifier distingue esse principal sem exigir provider fictício, mantendo
assinatura RS256/JWKS, issuer, audience, tempo e subject. A claim de provider
continua obrigatória nas rotas financeiras de providers. Na coluna
provider, A e B são organizações distintas; A+B indica a mesma wallet compartilhada.
Operadores precisam de identidade autenticada e grant operacional, não herdam
permissões de providers. `challenge` mantém os contratos atuais para o desafio.

| Endpoint / recurso | Provider autorizado | Outro provider sem grant | Operador |
|---|---|---|---|
| POST `/wallets` / player+moeda | `wallet.create`; positivo também `wallet.opening.credit`; cria grants explicitamente aprovados | 404 para player fora do cadastro autorizado; sem efeito/OPENING | Só com concessões explícitas de criação, não com grant de quarentena |
| GET `/wallets/:walletId` / wallet | `balance.read`; A+B podem ler saldo global se ambos receberam grant | 404; conhecer UUID/player não basta | Precisa de autorização financeira explícita |
| GET `/wallets/:walletId/ledger` / ledger completo | `ledger.read_all` na wallet, inclusive cursor/páginas; acesso global consciente | 404, inclusive A com apenas submit/read balance | Sem herança de grants operacionais |
| POST `/wallets/:walletId/reconciliation` / totais globais | `reconcile` explícito; read balance não basta | 404; nenhum log/métrica de reconciliação do recurso | Sem herança de grants operacionais |
| POST `/wagering/transactions` / wallet e comando | provider de body igual ao principal, `wager.submit`; preservar contexto e referências do domínio | 403 se tenta declarar outro provider; 404 sem grant, sem Inbox/Outbox/ledger/transação | Não pode se passar por provider por ser operador |
| GET `/wagering/transactions/:transactionId` / transação | provider persistido igual ao principal e `transaction.read_own` na wallet | 404 mesmo se ambos operam a wallet | Acesso financeiro exige política explícita separada |
| GET `/providers/:providerId/wagering/transactions/:externalTransactionId` / transação | mesma regra e URL igual ao principal; body divergente também é rejeitado | 403 para URL/body divergente; 404 para recurso invisível | Sem bypass por papel |
| GET `/operations/quarantine` / fila operacional global | Provider comum: 403, mesmo com todos os grants de wallet | 403; raw payload não concede vínculo | `quarantine.read`; resposta sem raw payload e sem segredos |
| POST `/operations/quarantine/:consumerName/:messageId/resolve` / mensagem | Provider comum: 403 | 403, nota não fornece identidade | `quarantine.resolve`; gravar ator/correlação no mesmo commit; 404 inexistente |
| GET `/health/live`, `/health/ready` | Público, sem mudança | Público | Público |
| GET `/metrics` | Público atualmente; exposição limitada pela infraestrutura em produção | Idem | Observabilidade em rede dedicada |

Quarentena não possui endpoint de redrive neste momento. Resolução não deve ganhar
redrive como efeito colateral. Não introduzir um módulo de propriedade de wallet.

## Dados legados e rollout

- Nenhuma linha financeira será reatribuída, removida ou reescrita. Conservar
  Money, snapshots, ledger, índices de idempotência, referências e histórico.
- Histórico de transações é evidência para **revisão**, não grant automático:
  poderia incluir acesso indevido atual; REJECTED e PENDING não comprovam consentimento.
- `__internal__`/OPENING não revela o criador autenticado. Wallet sem apostas,
  provider inativo, player sem cadastro ou múltiplos providers ambíguos ficam sem
  grant até confirmação por cadastro/operador confiável. Nenhum "primeiro provider"
  recebe propriedade exclusiva. Não escolher provider por maioria/última transação.
- Inventário somente leitura: wallets sem provider externo, wallets com vários
  providers, subjects sem vínculo administrativo e mensagens sem origem confiável.
  Registrar candidatos, justificativa, aprovador e conflitos; não exportar payloads
  sensíveis para logs. Bootstrap de operador por canal administrativo separado e
  temporário, sem autoelevação por request/role claim.
- Importação idempotente de grants aprovados em lotes, com chave natural e histórico
  de auditoria, validação de wallet/player/moeda e ausência de reserved provider.
  Não alterar a tabela de transações para preencher proprietário.
- Expandir schema primeiro; auditar decisões em ambiente restrito; reconciliar
  grants de todos os clientes OIDC legítimos; habilitar enforcement em implantação
  controlada. Em produção OIDC sem grant deve negar, não regressar a challenge.
  Janela de observação não significa proteção e não autoriza exposição pública.
- Jobs internos de pendência, Inbox/Outbox preservam processamento já aceito e suas
  garantias. Identidade técnica é configurada no processo, nunca enviada pelo cliente.
  Documentar aceitação/enfileiramento confiável antes de ativar restrições externas;
  não converter revogação em alteração retroativa de resultado financeiro.

## Plano de migration reversível definido na Tarefa 1 (histórico)

1. Nova migration **aditiva** após `Migration20261116110000`, sem editar as cinco
   existentes. Criar as cinco tabelas de autorização descritas acima. Chaves naturais
   de bindings/grants: `(issuer,subject,provider_id)`, `(provider_id,wallet_id,capability)`,
   `(provider_id,player_id,currency,capability)` e `(issuer,subject,action)` respectivamente.
   Uma linha guarda o estado atual; auditoria append-only registra cada mudança.
2. NOT NULL em identidade/ação/origem/granted_at; `revoked_at` nullable com CHECK
   `revoked_at >= granted_at`; CHECK de provider não técnico, moeda ISO e capabilities
   enumeradas por tabela (text+CHECK, sem enum global). Grant de wallet usa FK UUID
   para `wallets(id) ON DELETE RESTRICT`; nenhuma alteração nas FKs financeiras.
   Auditoria tem UUID próprio, correlação, ator, ação, recurso e decisão; evitar FK
   com cascade para preservar eventos de identidades/grants removidos administrativamente.
3. Índice PK dos grants cobre EXISTS por provider/wallet/capability; índice reverso
   `(wallet_id,provider_id)` auxilia revisão de compartilhamento. Índices por ator/tempo
   e recurso/tempo na auditoria. Não criar FK de provider/player para tabelas que não
   existem. Vínculo ativo de principal é verificado junto do grant na aplicação.
4. Importar somente concessões aprovadas em job separado, não em migration que
   presume proprietário por histórico. Testar idempotência, revogação e rollback
   numa base descartável com wallets compartilhadas e órfãs de evidência.
5. `down`: parar entradas externas e desabilitar enforcement apenas em ambiente
   isolado/restrito, exportar/verificar snapshot das tabelas novas e audit trail;
   recusar rollback operacional sem cópia recuperável após receber grants reais.
   Remover índices/trigger append-only de auditoria e **somente as novas tabelas**
   em ordem inversa. Não tocar wallets, ledger, transações, Inbox, Outbox ou quarentena.
   Isso reverte estrutura, mas não recria proteção: rollback de aplicação não pode
   reabrir acesso OIDC indiscriminado. Manter tráfego bloqueado até reativação segura.
6. Teste futuro up → importar → autorizar/revogar → backup/down → up/restaurar:
   hashes/contagens das tabelas financeiras e migrations existentes inalterados,
   grants e auditoria recuperados, unicidade global e A+B funcionando. Nenhum
   `migration:down`, DROP ou backfill real será executado na Tarefa 1.

Alternativas rejeitadas: owner exclusivo em wallets (contrato compartilhado),
confiar só em providerId/JWT (não prova relação com recurso), inferir grants do
histórico (elevação via atividade não autorizada), filtrar ledger por provider sem
mudar DTO (saldos incoerentes), liberar quarentena por provider no raw JSON (não
confiável), RLS isoladamente (pool/identity context ainda não definidos). RLS pode
ser defesa adicional futura, com testes de pool e workers, não substitui a política.

## Casos definidos na Tarefa 1 (histórico; atualizados na Tarefa 2)

Teste executável de auditoria:
[test/integration/provider-authorization-audit.spec.ts](../../test/integration/provider-authorization-audit.spec.ts),
registrado no runner obrigatório. Usa PostgreSQL, API Nest real e endpoint JWKS
local com chave RSA e JWTs assinados; nenhum mock de autenticação/banco/fila.
Executar `bun run build` antes da suíte: o caso A4 sobe também a API compilada em
Node e usa cliente Node real para GET com body. Ambos os processos desse teste
são encerrados ao final; não se altera a API ou o transporte para produzir um mock.
Os testes `AUDIT GAP` **passam ao reproduzir a exposição atual**. Isso não certifica
isolamento. Quando o enforcement chegar, substituir esses asserts pela matriz de
negação abaixo, conservando a reprodução no histórico Git. Não usar skips/xfail.

| Caso | Auditoria executável atual | Critério futuro obrigatório |
|---|---|---|
| Sem token nas nove rotas de negócio; health público | 401 e dependências reais up | Preservar |
| A/B na mesma wallet, mesma key e external ID | Duas transações, replay A com saldo original | Pré-provisionar grants A+B, preservar resultado e unicidade |
| Token B, body ou URL A | 403 e sem aposta persistida | Preservar e negar também combinações body/URL conflitantes |
| Token B, URL A, GET body B | Reproduz 200 indevido no runtime Node | 403; consultar com provider autenticado, nunca priorizar body |
| B conhece UUID de wallet/transação A, sem vínculo persistente | Reproduz leitura, ledger paginado e reconciliação 200 | 404 sem metadados, cursor ou efeitos |
| Criar wallet para player arbitrário com crédito | Reproduz OPENING e conflito global | Negar sem grants player/create/credit; permitir zero sem credit; confirmar ausência de OPENING/Outbox na negação |
| Provider B sem privilégio operacional | Reproduz listagem e resolução global | Ambas 403, status/nota/resolved_at intactos; ausência de raw payload na resposta |
| Operador com read mas sem resolve e vice-versa | Planejado, não implementado/executado | Cada ação exige sua capability; ator real e trilha atômica |
| A+B compartilham wallet mas só A tem ledger.read_all | Planejado | B submit permitido; ledger/reconcile negados; A lê global apenas com grants respectivos |
| B tenta ler transação A em wallet compartilhada | Reproduz leitura por UUID atualmente | 404 mesmo com grant de leitura das próprias transações; permitir consulta de B |
| Identidade de outro issuer/sub, claim adulterada, grant revogado/ausente | Planejado | Negar antes de efeitos/replay; JWT assinado válido sem vínculo não autoriza |
| Revogação concorrente e erro de banco de grants | Planejado | Fronteira transacional descrita acima; 503 sem fail-open |
| Legacy sem vínculo, OPENING e raw inválido | OPENING/raw inválido caracterizados | Não inferir owner; operador trata quarentena não atribuível |
| SQS interno, pending workers, idempotência, AUTH_MODE=challenge | Suíte existente | Preservar domínio/canal confiável; testar ingresso de produção separadamente |

Risco residual da Tarefa 1: aquela entrega **não corrigia A1–A7**. Produção exige enforcement,
provisionamento confiável, testes negativos de matriz e implantação controlada.
Acesso global de ledger/saldo deve ser aprovado explicitamente pelo contrato de
compartilhamento; clientes que não o aceitam não recebem essas capabilities.

## Evidência local da Tarefa 1 (histórico)

Worktree `/workspace/jungle-auth-audit`, branch `security/provider-authorization-audit`,
base remota confirmada acima; o checkout original estava limpo e permaneceu intacto.
Não havia branch local `main`; `origin/main` foi consultada diretamente e usada
como base, sem alterar a branch `work` do checkout original.
Git 2.52.0, Bun 1.1.38, Node 24.22.1, Docker Engine 29.9.2 e Compose v2.40.3
estão acessíveis no ambiente Linux gerenciado. Isso não confirma disponibilidade
de Docker Desktop na máquina do usuário. Projeto Compose isolado `jungle-auth-audit`,
PostgreSQL 16 e LocalStack 3.8, ambas as dependências healthy e três filas existentes.

- `bun run typecheck`, `bun run lint`, `bun run format:check`, `bun run build`: passaram.
- `bun run db:migration:check`: nenhuma migration pendente; nenhuma nova migration criada.
- Teste focado: 7 passaram, 0 falhas; inclui reproduções conhecidas, não correções.
- `bun run test:all`: 93 testes, 13 targets, 0 falhas, 0 erros, 0 skips;
  inclui concorrência, PostgreSQL e SQS real em LocalStack.
- `docker compose config -q` passou; serviços iniciados e readiness PG/SQS verificado.
- Nenhum rollback destrutivo de schema ou alteração de regras financeiras.
- Smoke de crash/restart de container não executado nesta tarefa: não houve mudança
  de container, workers ou finanças. Os testes novos também encerram a API Node auxiliar.
- Branch mantida separada; sem push, merge ou confirmação de CI para os novos commits.

Resultados JUnit/logs da suíte estão em `.test-results/` (ignorados pelo Git).
O build e os testes ocorreram nesta instância, não em um novo clone ou no CI remoto.

## Implementação da Tarefa 2

- `Migration20261116120000` cria as cinco tabelas, chaves compostas, FK de wallet
  com RESTRICT, CHECKs de capabilities/identidade/moeda/timestamps e índices de
  consulta. Não faz backfill nem altera tabelas ou constraints financeiras.
- Entidades MikroORM em `authorization.entities.ts`; `AuthorizationStore` oferece
  concessão idempotente, revogação e reconcessão apenas a código administrativo
  confiável. Não existe endpoint público de grants. Ator e origem são obrigatórios;
  quem opera esse código deve autenticar o administrador fora dos DTOs de clientes.
- Triggers registram alterações de grants atomicamente e recusam DELETE de grants
  e UPDATE/DELETE da auditoria. A aplicação usa INSERT/UPDATE autorizados; TRUNCATE,
  alteração de triggers e DDL exigem conta administrativa restrita. O usuário
  PostgreSQL de desenvolvimento do Compose não representa a separação de papéis
  exigida em produção. Não há RLS nesta entrega.
- `ResourceAuthorization` é a camada de aplicação da política; o interceptor
  global executa os handlers HTTP dentro de sua transação. Binding e grants ativos
  recebem FOR SHARE via `EntityManager.execute`, mantendo locks até commit. A
  revogação usa UPDATE nas mesmas linhas, aguarda operações já autorizadas e impede
  as próximas. Sem cache positivo de permissões. Consultas por transação verificam
  provider persistido; a mesma wallet admite grants para múltiplos providers.
- O guard compara body e URL independentemente e rejeita AUTH_MODE desconhecido.
  `challenge` permanece permissivo. Rotas públicas têm marcação explícita;
  política ausente em OIDC falha fechada. JWT RS256/JWKS continua obrigatório.
- Operadores usam issuer/subject validado e grant de ação separado, sem provider
  fictício. A claim de provider continua obrigatória nas rotas de providers.
  Read não concede resolve. A decisão e ator de resolução são auditados no mesmo
  commit do status/nota; raw payload e nota não entram na auditoria de autorização.
- Criar wallet requer grant de player/moeda e, para saldo positivo, autorização
  separada de OPENING. Não há concessão implícita ao criador: a lista de grants
  iniciais automaticamente aprovados é vazia. O resultado da criação é retornado,
  mas leituras/operações seguintes exigem provisionamento explícito por UUID do
  recurso persistido. Cadastro fora do grant recebe 404, sem revelar duplicidade;
  cadastro autorizado preserva 409. Não existe política de atribuição de legados.
- REJECTED e replays preservam persistência/snapshot: um HTTP 422 lançado pelo
  controller não desfaz um resultado financeiro terminal já aceito pelo caso de
  uso. A autorização é verificada antes de entrar no handler, inclusive em replay.
  Falhas SQL na transação impedem commit e retornam 503. Denegações 403/404 da
  camada de autorização são auditadas após rollback; autenticação/mismatch rejeitado
  no guard não escreve uma decisão de recurso. Isso não altera o ledger financeiro.
- Casos de uso existentes continuam sendo APIs internas confiáveis para workers.
  As entradas HTTP obrigatoriamente passam pela camada de autorização; não expor
  métodos financeiros internos diretamente em novos transports. SQS permanece o
  canal interno confiável do desafio, sem interpretar body como identidade externa.

### Rollback e operação

O `down` recusa dados de autorização existentes sem
`AUTHZ_ROLLBACK_BACKUP_CONFIRMED=1`. Essa variável é uma **confirmação do operador**,
não prova automática da existência/validade de um backup. Pare entradas, faça
backup recuperável das cinco tabelas e da auditoria, valide checksum/restauração e
somente então confirme a variável no processo que executa `db:rollback`.
Não use isso para reabrir tráfego OIDC com uma versão antiga permissiva.
O teste CI exporta `pg_dump --data-only` das cinco tabelas para `.test-results/`,
verifica checksum e só então confirma rollback no banco descartável. Migrations
históricas não foram alteradas. Teste dedicado cobre down/up/restauração com
preservação de timestamps PostgreSQL e de todos os registros financeiros.

Limites operacionais: provisionamento de identidades/grants legítimos é manual por
canal administrativo confiável; nenhum cliente/legado recebe acesso até aprovação.
A auditoria e os backups contêm metadados de autorização e exigem retenção/acesso
restritos. Grant global de ledger/saldo é compartilhamento consciente. Não foram
implementados IdP hospedado, RLS, ingress autenticado de produção para SQS ou
interface administrativa. Essas limitações não autorizam fallback permissivo.

### Provisionamento explícito por código administrativo

Use `AuthorizationStore` apenas em processo administrativo com acesso autorizado
à conexão PostgreSQL. Exemplo de sequência (dados aprovados fornecidos por canal
confiável, nunca derivados de um request de negócio):

```ts
const store = new AuthorizationStore(orm.em.fork());
const actor = { issuer: adminIssuer, subject: adminSubject, source: approvedChangeId };
await store.grant({ kind: 'binding', issuer: trustedIssuer, subject: trustedSubject,
  providerId: approvedProvider }, actor);
await store.grant({ kind: 'wallet', providerId: approvedProvider,
  walletId: approvedExistingWalletId, capability: 'wager.submit' }, actor);
// Conceder balance.read, transaction.read_own, ledger.read_all e reconcile
// individualmente, somente se aprovados. Outro provider usa outra linha.
await store.revoke({ kind: 'wallet', providerId: approvedProvider,
  walletId: approvedExistingWalletId, capability: 'wager.submit' }, actor);
```

Esse processo confia na identidade administrativa estabelecida fora da aplicação;
`actor` é atribuição de auditoria e não um mecanismo de autenticação. Conta de
serviço HTTP/worker não deve poder executar DDL, desativar triggers, truncar essas
tabelas ou provisionar grants por rotas externas. O Compose continua usando conta
local de desenvolvimento; separação de credenciais PostgreSQL é requisito do deploy.

## Tarefa 3 — Cobertura integral de endpoints financeiros

`AuthorizeResource` agora combina política e guard JWT numa única declaração;
não é necessário lembrar um segundo decorator de autenticação. Ausência de
principal retorna 401 com `AUTHORIZATION_REQUIRED`; vínculo de identidade ausente
ou provider divergente retorna 403; recurso invisível/inexistente retorna o mesmo
404 genérico. Policy ausente em OIDC continua falhando fechada.

A implementação da Tarefa 2 foi preservada e exercitada por testes HTTP adicionais
para todos os tipos financeiros, recursos exclusivos/compartilhados e concorrência
real. Compartilhar wallet não concede leitura das transações privadas de outro
provider. A referência de REFUND/ROLLBACK continua sujeita às regras financeiras
do mesmo provider/player/wallet/moeda/rodada. Nenhuma migration, regra financeira
ou algoritmo de saldo foi alterado na Tarefa 3.

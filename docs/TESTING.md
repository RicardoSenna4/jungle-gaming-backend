# TESTING — Reprodutibilidade, evidências e gates

## Execução

Use Bun 1.1.38, PostgreSQL 16 e LocalStack SQS. Inicie `docker compose up -d postgres localstack`,
aguarde filas e execute `bun run db:migrate` antes das integrações.

| Comando | Escopo |
|---|---|
| `bun run test:unit` | domínio, hash, logger, métrica e runners |
| `bun run test:integration:postgres` | banco, schema, HTTP, reversões, ledger, timers e publishers |
| `bun run test:integration:sqs` | envio real/ack/outbox com LocalStack |
| `bun run test:concurrency` | múltiplos processos e wallet compartilhada |
| `bun run test:recovery` | outbox, reversões, inbox e SQS |
| `bun run test:all` | todos os cenários obrigatórios, sequencial por spec |
| `SMOKE_ALLOW_DISRUPTION=1 bun run smoke:compose` | HTTP + SQS + outbox + reinício SIGKILL/SIGTERM com API em Docker Compose isolado |
| `bun run db:migration:check` | migrations não aplicadas |
| `bun run typecheck && bun run lint && bun run format:check && bun run build` | qualidade |

O runner `scripts/test-suite-runner.ts` executa cada spec separadamente,
passa as flags `RUN_INTEGRATION` e `RUN_SQS_REAL`, grava JUnit em
`.test-results/` e **falha se houver skips, zero testes, falhas ou arquivo não registrado**.
Não rodar as specs que compartilham TRUNCATE em paralelo no mesmo banco.

## Critérios de aceitação

| Cenário | Evidência esperada |
|---|---|
| BET 80 + 80 sobre 100 | 1 PROCESSED, 1 REJECTED, saldo 20, um débito |
| 50 requisições idênticas | 1 efeito e 49 replays |
| 3 processos | consistência/versão/ledger idênticos |
| Wallets distintas | processamento paralelo sem lock global |
| REFUND/ROLLBACK | uma reversão por referência, valor integral, códigos distintos |
| Referência antes da origem | PENDING reprocessado pelo timer real |
| Constraints/ledger | SQL direto rejeitado, imutabilidade/aritmética |
| Cursor | todas as entradas sem omissão/duplicata |
| SQS | Inbox persistente, ACK depois do commit, redelivery sem novo débito |
| Outbox | claims seguros, publish pós-commit, retry, eventId estável |
| Reconciliação | diferença sinalizada e não autocorrigida |

**Evidência válida:** comando, SHA testado, execução CI, contagem PASS/FAIL/SKIP
e, quando houver falha, logs sem segredos. Não inferir um cenário não testado
a partir de outro ou de relatórios históricos.

### CI

**Evidências em links diretos:** [CI](../.github/workflows/ci.yml), [runner de 12 alvos](../scripts/test-suite-runner.ts), [concorrência real](../test/integration/concurrency.spec.ts), [SQS/LocalStack](../test/integration/sqs-localstack.spec.ts), [crash/restart em Compose](../scripts/smoke-compose.ts) e [evidência de CI com distinção entre snapshot histórico e último commit](CI_EVIDENCE.md). Quando publicados, os artefatos e logs ficam associados à execução específica do Actions.

As falhas em **commits intermediários** não tornam o HEAD automaticamente inválido nem devem ser apagadas para mascarar tentativas anteriores. Sempre confira o resultado **do commit submetido**; o badge da main pode mudar após novos commits.


O [snapshot aprovado #43770950239](https://github.com/RicardoSenna4/jungle-gaming-backend/actions/runs/43770950239) do commit `3e540c6` comprova 80 testes sem falhas/skips (12 alvos) e smoke real da aplicação. O script `smoke:compose` **derruba e reinicia o serviço `api`** e consome mensagens da fila de eventos local; nunca execute em sistemas compartilhados ou em produção. Trata-se de **uma execução histórica**, não de certificação automática de commits posteriores. Consulte [CI_EVIDENCE](CI_EVIDENCE.md) e valide o SHA entregue.


Workflow: [ci.yml](../.github/workflows/ci.yml). Executa em runner descartável,
sobe PostgreSQL/LocalStack, aplica migrations e executa o runner sem skips.
Reverte a cadeia completa no banco isolado e reaplica migrations.
[Consulte execuções no GitHub Actions](https://github.com/RicardoSenna4/jungle-gaming-backend/actions).
A aprovação vale somente para o SHA de cada execução.

### Limites da prova

O E2E com LocalStack não comprova automaticamente idêntico comportamento no
SQS gerenciado em AWS; duplicatas continuam possíveis fora da janela FIFO.
A presença de métodos `runOnce` não substitui prova de timer/agendamento real.
A execução de SIGKILL/SIGTERM da API já foi provada no CI, mas injeção de falha entre send/mark da outbox e entre commit/ACK do consumer continuam casos distintos, que não podem ser inferidos apenas da reinicialização. Ver [FAILURE_RECOVERY](FAILURE_RECOVERY.md).

## Autorização persistente (Tarefas 1 e 2)

`provider-authorization-audit.spec.ts` agora testa o enforcement da ADR-019:
permitidos/negados, wallet compartilhada sem compartilhamento de transações,
revogação antes de replay, REJECTED durável, crédito inicial separado e operações
privilegiadas. Os antigos asserts `AUDIT GAP` permanecem no histórico Git e foram
substituídos por negações, sem skips ou enfraquecimento das garantias.
Usa Nest HTTP, PostgreSQL e JWKS local com tokens RSA assinados; LocalStack real
verifica readiness. Execute `bun run build` antes: o caso GET com body também
executa a API compilada e o cliente em Node, ambos encerrados no teste.

`authorization-persistence.spec.ts` testa entidades/constraints, idempotência de
provisionamento, oito concessões concorrentes, revogação com waiters observados
no PostgreSQL, legados sem inferência e migration down/up com backup/restauração.
O teste de migration cria e exclui **somente seu banco descartável** `authz_migration_*`;
a conta de testes precisa de CREATEDB e visibilidade de pg_stat_activity. Os demais
fixtures truncam tabelas somente no banco isolado de testes. Nunca executar contra
produção/dados reais. Ambos os specs estão no runner obrigatório, que rejeita skips.

Rollback com dados exige confirmação explícita após backup verificado; veja a ADR.
O CI preserva o dump e checksum em `.test-results/` antes do rollback descartável.

## Cobertura financeira HTTP (Tarefa 3)

`financial-resource-authorization.spec.ts` percorre todos os endpoints financeiros
com JWTs RS256/JWKS reais de dois providers: criação, wallet, ledger, reconciliação,
BET/WIN/LOSS/REFUND/ROLLBACK e consultas de transações por UUID/ID externo.
Valida permissões distintas em wallets exclusivas/compartilhadas, negações sem
metadados, snapshots de replay e persistência financeira após rejeição. A disputa
HTTP simultânea de duas BETs de 80 sobre saldo 100 termina em saldo 20, um débito
e uma rejeição; 12 replays não duplicam efeito. Um teste observa waiters reais no
PostgreSQL durante revogação e confirma ausência de transação/ledger/Outbox novos
para a requisição negada. Está registrado no runner obrigatório.

## Papéis administrativos e métricas (Tarefa 4)

`administrative-role-access.spec.ts` usa JWTs RS256/JWKS e PostgreSQL reais para
verificar token ausente, provider comum, papel/permission insuficientes, admin sem
grant, administrador autorizado, read separado de resolve, negações cruzadas e
auditoria sem dados sensíveis nos logs. Cobre claims/papéis configuráveis e política
de `/metrics` em OIDC/challenge/production, sem desligar asserts ou introduzir skips.
`administrative-claims-policy.spec.ts` valida comparação exata, valores malformados
e configuração fail-closed. O spec HTTP está registrado no runner obrigatório.

## Hardening OIDC (Tarefa 5)

Os testes de guard e `oidc-hardening.spec.ts` usam um IdP HTTP real em loopback,
com RSA 2048, JWKS rotativo, falhas, timeout e discovery adversarial. O bypass de
TLS local exige `NODE_ENV=test|development` e `OIDC_ALLOW_LOOPBACK_HTTP=true`;
produção ignora essa exceção. Os fixtures de integração declaram isso explicitamente.

## Quarentena (Tarefa 6)

`quarantine-management.spec.ts` usa PostgreSQL/LocalStack reais para paginação,
RBAC, redrive concorrente, duplicatas financeiras, falha de envio, falha SQL antes
do claim e após envio, e retomada por API Node em novo processo. `quarantine-migration.spec.ts`
verifica preservação de disposições legadas e up/down/up em banco descartável,
com recusa de rollback ativo/sem backup e restauração de grants explícitos.

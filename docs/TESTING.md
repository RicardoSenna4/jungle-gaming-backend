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

## Auditoria de autorização (Tarefa 1)

`provider-authorization-audit.spec.ts` está registrado em `test:integration:postgres`
e `test:all`. Usa Nest HTTP, PostgreSQL e JWKS HTTP local com tokens RSA assinados,
sem substituir integrações por mocks. LocalStack real deve estar ativo para readiness.
Executar `bun run build` antes da suíte: o caso de GET com body usa adicionalmente
a API compilada em Node, caminho suportado por `bun run start`, e cliente Node,
pois o transporte Bun testado descarta esse body. O teste encerra os processos criados.
O runner continua rejeitando skips, zero testes e specs não registradas.

Os casos `AUDIT GAP` esperam a exposição atual para documentá-la: **não são prova
de isolamento nem critérios de aceitação de produção**. O contrato de negação que
deverá substituir esses asserts está na [ADR-019](adr/019-provider-resource-authorization.md).
Não introduzir skips para manter os testes passando quando o enforcement chegar.
O fixture trunca tabelas somente na base isolada de testes; jamais usar produção.

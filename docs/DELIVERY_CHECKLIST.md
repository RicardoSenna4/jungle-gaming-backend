# Checklist de aceite da entrega

**Código avaliado:** `3cdb0eb`, [Actions #43760715469](https://github.com/RicardoSenna4/jungle-gaming-backend/actions/runs/43760715469), **80 PASS/0 FAIL/0 SKIP**. Todos os estados a seguir distinguem prova automatizada de aprovação humana.

| Gate | Requisito | Estado | Evidência |
|---|---|---|---|
| G01 | Bun, NestJS, TypeScript strict, MikroORM, PostgreSQL, SQS, Compose | PASS | package.json, CI |
| G02 | Migrations + constraints reais | PASS | schema-contracts, migration up/down/up |
| G03 | Money exato, extremos, moeda | PASS | money.spec, schema-contracts |
| G04 | BET/WIN/LOSS/OPENING e ledger | PASS | wager-processing, wallet-persistence |
| G05 | REFUND/ROLLBACK e pending/TTL | PASS | reversal-processing, pending-worker |
| G06 | Replay original, hash e conflito | PASS | wager-processing, concurrency |
| G07 | 50 operações idênticas | PASS | concurrency cenário B |
| G08 | BET 80+80 / saldo 100 | PASS | concurrency cenário A |
| G09 | ≥3 processos e wallets distintas | PASS | concurrency cenários C/D |
| G10 | Worker pending agendado | PASS no CI | pending-worker (sem ensaio de kill real) |
| G11 | Inbox, ACK, redelivery, DLQ, backoff | PASS parcial | sqs-consumer/sqs-localstack; SIGTERM real pendente |
| G12 | Outbox, claims, retries, publicação pós-commit | PASS parcial | outbox-publisher/sqs-localstack; SIGKILL real pendente |
| G13 | Eventos concretos versionados | PASS | events unit + outbox/LocalStack |
| G14 | HTTP, cursor, status, extensão auth | PASS | http-api, ledger-pagination, provider-identity.guard |
| G15 | JSON logs, métricas, health, reconciliação | PASS | json-logger, metrics, health, http-api |
| G16 | CI do código executa todos os testes sem skips | PASS | Actions #43760715469 |
| G17 | README, arquitetura e evidências consistentes | PASS documentação | README, ARCHITECTURE, docs |
| G18 | Sem segredos reais, review e instalação limpa | PENDENTE HOMOLOGAÇÃO | Conferir histórico + smoke local |
| G19 | Acesso do avaliador ao repositório privado | PENDENTE HUMANO | Confirmar permissões |
| G20 | Revisão final e submissão ao recrutador | PENDENTE HUMANO | Confirmação do proprietário |

## Para você executar antes de enviar

- [ ] Clonar do zero na sua máquina, executar `docker compose up --build -d` e verificar API/health.
- [ ] Exercitar wallet 100, BET 80+80, replay com 50 requisições e comparar ledger.
- [ ] Executar SQS redelivery/DLQ e matar/reiniciar o consumer **em ambiente de teste**, sem alterar dados reais.
- [ ] Reiniciar o publisher com outbox pendente, acompanhar eventos e `eventId`.
- [ ] Conferir que nenhum segredo aparece no histórico, logs ou arquivos.
- [ ] Confirmar que os avaliadores podem ler o repositório (atualmente privado).
- [ ] Confirmar prazo/formato/regras sobre IA com a Jungle Gaming.
- [ ] Ler README e arquitetura e revisar os commits antes da submissão.

**Não declarar entrega 100% concluída** até todos os passos humanos serem realizados.

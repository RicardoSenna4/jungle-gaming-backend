# Checklist de aceite da entrega

**CI a conferir antes de submeter:** [executar o CI da `main`](https://github.com/RicardoSenna4/jungle-gaming-backend/actions/workflows/ci.yml?query=branch%3Amain); compare o SHA com o [HEAD da `main`](https://github.com/RicardoSenna4/jungle-gaming-backend/commits/main). **Snapshot histórico comprovado:** [#43770950239 no commit `3e540c6`](https://github.com/RicardoSenna4/jungle-gaming-backend/actions/runs/43770950239) — **80 PASS / 0 FAIL / 0 SKIP**, smoke em container e SIGKILL/SIGTERM. Para distinguir snapshots de estado atual, consulte [CI_EVIDENCE.md](CI_EVIDENCE.md). Os estados abaixo não dispensam homologação humana.

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
| G10 | Worker pending agendado | PASS no CI | pending-worker; smoke reinicia API, mas não interrompe uma referência durante processamento |
| G11 | Inbox, ACK, redelivery, DLQ, backoff | PASS parcial | sqs-localstack e smoke com SIGTERM; falta induzir parada com mensagem em voo |
| G12 | Outbox, claims, retries, publicação pós-commit | PASS parcial | Outbox SQS real e smoke com SIGKILL; falta interrupção forçada entre SendMessage e marca SQL |
| G13 | Eventos concretos versionados | PASS | events unit + outbox/LocalStack |
| G14 | HTTP, cursor, status, extensão auth | PASS | http-api, ledger-pagination, provider-identity.guard |
| G15 | JSON logs, métricas, health, reconciliação | PASS | json-logger, metrics, health, http-api |
| G16 | CI do código executa todos os testes sem skips e smoke container | PASS no snapshot; verificar SHA entregue | [Evidência histórica e CI atual](CI_EVIDENCE.md) |
| G17 | README, arquitetura e evidências consistentes | PASS documentação | [README](../README.md), [API](API.md), [guia de execução](DEMO.md), [rastreabilidade](REQUIREMENTS_TRACEABILITY.md) |
| G18 | Sem segredos reais, review e instalação limpa | PENDENTE HOMOLOGAÇÃO | Conferir histórico + smoke local |
| G19 | Visibilidade e acesso dos avaliadores | PENDENTE HUMANO | Repositório consultado como público; confirmar se essa visibilidade foi autorizada e se atende às regras do processo seletivo |
| G20 | Revisão final e submissão ao recrutador | PENDENTE HUMANO | Confirmação do proprietário |

## Para você executar antes de enviar

- [ ] Clonar do zero na sua máquina e seguir o [guia passo a passo](DEMO.md) em PowerShell. Se usar WSL/Ubuntu ou Git Bash, conferir Git, curl, Docker Desktop e integração WSL conforme as instruções. O CI reproduziu o fluxo em Linux, mas **não substitui testes locais em Windows/WSL/Git Bash**.
- [ ] Exercitar wallet 100, BET 80+80, replay com 50 requisições e comparar ledger.
- [ ] Executar SQS redelivery/DLQ e matar/reiniciar o consumer **em ambiente de teste**, sem alterar dados reais.
- [ ] Reiniciar o publisher com outbox pendente, acompanhar eventos e `eventId`.
- [ ] Conferir que nenhum segredo aparece no histórico, logs ou arquivos.
- [ ] Confirmar se a visibilidade **pública** atual do repositório foi autorizada, se atende às regras da Jungle Gaming e se o avaliador consegue visualizar o conteúdo sem login.
- [ ] Confirmar prazo/formato/regras sobre IA com a Jungle Gaming.
- [ ] Ler README e arquitetura e revisar os commits antes da submissão.

**Não declarar entrega 100% concluída** até todos os passos humanos serem realizados. A presença de checks vermelhos em commits anteriores representa o histórico real; a comprovação da entrega é o CI do SHA final.

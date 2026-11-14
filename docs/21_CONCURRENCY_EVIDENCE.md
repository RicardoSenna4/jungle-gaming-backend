# Evidências de concorrência e consistência — Tarefa 7

## Estratégia

A unidade de concorrência é a linha da wallet. `WagerProcessingService` executa `EntityManager.transactional` e busca a wallet com `LockMode.PESSIMISTIC_WRITE`, equivalente a `SELECT ... FOR UPDATE`. Não existe mutex global, lock em memória ou partição global por aplicação. O lock é mantido até o flush do wager transaction, atualização da wallet, ledger, outbox e commit.

A ordem de persistência foi corrigida para inserir a `wager_transaction` antes do ledger, pois o MikroORM não inferia a dependência quando o ledger guardava apenas `transactionId` escalar. O flush intermediário permanece dentro da mesma transação SQL e não reduz a atomicidade.

## Idempotência concorrente

Uma corrida no índice único pode ocorrer antes de a requisição perdedora conseguir ler o registro vencedor. O caminho de unique violation agora faz até cinco leituras com espera incremental de 10, 20, 30, 40 e 50 ms. Se encontrar a mesma chave e hash, retorna o snapshot como replay. Payload divergente continua sendo conflito. Deadlock PostgreSQL (`40P01`) e serialization failure (`40001`) têm no máximo três retries com backoff de 10, 20 e 30 ms; rejeições de negócio não são retryadas.

## Harness real

`test/integration/concurrency-worker.ts` inicia um processo Bun independente, abre sua própria conexão PostgreSQL e executa o caso de uso. `test/integration/concurrency.spec.ts` inicia processos com `Bun.spawn` em paralelo. Não há mocks, nem simulação sequencial por Promises.

## Cenários executados

| Cenário | Execução | Resultado esperado | Resultado observado |
|---|---|---|---|
| A | 2 processos, mesma wallet, BET 80 + BET 80, saldo 100 | 1 PROCESSED, 1 REJECTED/INSUFFICIENT_FUNDS, saldo 20, 1 débito | PASS |
| B | 10 processos × 5 chamadas, mesma key/payload | 50 respostas, 1 efeito, 49 replays, 1 ledger, conflito divergente | PASS |
| C | 3 processos, wallets diferentes | 3 operações processadas sem lock global | PASS |
| D | 3 processos independentes, mesma wallet, três BET 10 | saldo 70, versão 4, três débitos, saldo reconciliado pelo ledger | PASS |

A suíte A–D foi executada duas vezes consecutivas após a correção final da corrida de unique em PostgreSQL 16.15 real, com 4 testes e 23 assertions em cada rodada. Uma execução anterior revelou uma corrida rara que retornava `EXTERNAL_TRANSACTION_EXISTS`; o retry limitado de convergência foi adicionado e as duas execuções seguintes passaram:

```text
final_run=1: 4 pass, 0 fail
final_run=2: 4 pass, 0 fail
```

## Consistência final

O cenário D reconstrói o saldo com `SUM(CREDIT) - SUM(DEBIT)` diretamente no PostgreSQL e compara o resultado com `wallets.balance`. O valor reconstruído foi `70.00`, igual ao saldo persistido. O ledger continua protegido pelo trigger append-only.

## Ambiente

- PostgreSQL 16.15 local, iniciado em `localhost:5432`.
- Banco: `jungle`.
- Runtime: Bun 1.1.38.
- Migrations MikroORM aplicadas com sucesso.
- A migration TypeORM histórica foi separada em `typeorm-migrations/` para não ser descoberta pelo Migrator MikroORM.

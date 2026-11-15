# Achados da auditoria — F00/F01

**Snapshot:** `688ba474e1bff084a2c72495ba3616444a2c2338`
**Branch de correção:** `fix/challenge-f00-f01`
**Data:** 15/11/2026
**Escopo:** somente baseline e execução completa dos testes no GitHub Actions. Não avalia nem corrige nesta fase as regras financeiras do produto.

## Achados confirmados


| ID | Classificação | Gravidade | Evidência no snapshot | Efeito / encaminhamento |
|---|---|---|---|---|
| AUD-001 | CONFIRMADO | P0 | `.github/workflows/ci.yml` executa `bun test` no job `verify` sem `RUN_INTEGRATION=1` ou `RUN_SQS_REAL=1`. No SHA-base, a reprodução em Bun 1.1.38 terminou com **30 pass, 29 skip, 0 fail**, exit code 0. | Suites obrigatórias podiam ser ignoradas enquanto o job continuava verde. F01 adiciona gate JUnit que falha em qualquer skip. |
| AUD-002 | CONFIRMADO | P0 | O job `integration-services` sobe PostgreSQL/LocalStack, aplica migrations e chama apenas `sqs-localstack.spec.ts`; não executa as sete outras specs PostgreSQL. | Integrações de API, persistência, transações, Inbox/Outbox, reversões e concorrência não eram verificadas por esse workflow. F01 executará todas as oito specs de integração, incluindo a SQS real. |
| AUD-003 | CONFIRMADO | P0 | `package.json` do snapshot não tinha comandos separados para `test:integration:postgres`, `test:integration:sqs`, `test:concurrency`, `test:recovery` ou `test:all`; o workflow-base não chamava o comando genérico `test:integration`, e esse comando não habilitava `RUN_SQS_REAL`, necessário para o caso LocalStack real. | Não havia uma interface explícita que afirmasse quais testes eram obrigatórios nem que recusasse zero testes/skips. F01 cria scripts nomeados e verificados por JUnit. |
| AUD-004 | CONFIRMADO | P0 | O comando `db:rollback` executa uma chamada `mikro-orm migration:down`; o workflow-base chama-o uma vez após aplicar a cadeia inteira. Existem quatro arquivos de migration no snapshot. | O workflow-base não demonstrava rollback da cadeia completa. F01 conta migrations e reverte cada uma em sequência no banco descartável, depois reaplica e verifica a cadeia. |
| AUD-005 | CONFIRMADO | P1 | O workflow-base não configurava reporter JUnit nem fazia upload de resultados de teste como artefato. | Falta de relatório consultável por suíte quando o job termina ou falha. F01 gera JUnit/log por alvo e publica artefato no Actions. |
| AUD-006 | CONFIRMADO | P1 | `sqs-localstack.spec.ts` chama o teste de E2E real, mas a assertion explícita é somente a contagem da transação persistida; não verifica diretamente contagem da fila após ACK, conteúdo de Inbox/ledger/Outbox, redelivery, reinício ou DLQ. | O único cenário SQS verde no baseline é limitado; não prova os contratos de falha/recovery. F01 garante que a spec rode; ampliar assertions fica para F04/F05, fora do escopo autorizado agora. |
| AUD-007 | RISCO A VERIFICAR | P1 | As specs PostgreSQL compartilham o banco configurado e fazem `TRUNCATE` em tabelas compartilhadas em hooks de limpeza; a CI-base não executava o conjunto completo para observar interleavings. | Uma execução concorrente entre arquivos poderia causar interferência. O runner F01 evita essa hipótese executando cada arquivo em processo separado e em série; o paralelismo interno do cenário multiprocesso é preservado. |
| AUD-008 | CONFIRMADO | P1 | No ambiente de execução desta tarefa, `docker` não está instalado (`docker: command not found`). | Não é possível reproduzir PostgreSQL/LocalStack em containers neste sandbox. A validação integral de serviços depende do GitHub Actions em runner limpo; nenhuma aprovação de integração local será alegada. |

## Riscos a verificar em fases posteriores

| ID | Classificação | Gravidade | Questão pendente | Fase sugerida |
|---|---|---|---|---|
| AUD-009 | RISCO A VERIFICAR | P0 | Contextos isolados do MikroORM e ciclo real dos workers agendados fora de HTTP. | F02 |
| AUD-010 | SEM EVIDÊNCIA no CI-base | P0 | Provas de concorrência multiprocessos, recovery pós-commit/pré-ACK, publisher duplo e crash pós-send/pré-mark no SHA efetivamente entregue. Há relatórios locais históricos, que não substituem execução no SHA atual/CI. | F02–F05 |
| AUD-011 | SEM EVIDÊNCIA no CI-base | P1 | Assertions de log JSON/redaction, DLQ, backoff, contratos HTTP, cursor e health com dependências indisponíveis. | F04–F09 |

## Verificações executadas no F00

- HEAD e `origin/main` do clone no início: `688ba474e1bff084a2c72495ba3616444a2c2338`; árvore de trabalho limpa.
- `bun --version`: `1.1.38`.
- `bun test` no snapshot-base: **30 pass, 29 skip, 0 fail**, 59 testes/19 arquivos, exit code 0.
- GitHub Actions-base: [run 43751276240](https://github.com/RicardoSenna4/jungle-gaming-backend/actions/runs/43751276240), conclusão `success`, mesmo SHA; jobs `verify` e `integration-services` verdes.
- Comparação `CHALLENGE_SPEC.md` vs README upstream: byte a byte idênticos; SHA-256 `47795fce2fc38cae5f1b91368ebaf80b7a2ed1fe147f36704b665faf0613812e`.
- `docker version` e `docker compose version`: ambos bloqueados por `docker: command not found`.

Este registro não afirma que os riscos posteriores sejam defeitos confirmados. As evidências correspondentes devem ser coletadas antes de decidir se é necessário alterar o comportamento financeiro.

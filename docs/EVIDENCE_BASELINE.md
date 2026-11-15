# Evidências do baseline — F00

**Repositório:** `RicardoSenna4/jungle-gaming-backend`
**SHA-base:** `688ba474e1bff084a2c72495ba3616444a2c2338`
**Data da coleta:** 15/11/2026
**Branch aberta depois do baseline:** `fix/challenge-f00-f01`; a `main` não foi modificada.

## Snapshot e especificação


| Verificação | Resultado | Evidência |
|---|---|---|
| `git status --porcelain` antes da branch | árvore limpa | `git status --short --branch` mostrou `main` no SHA `688ba47` e sem arquivos modificados |
| HEAD local vs `origin/main` | iguais no início | ambos apontavam para `688ba474e1bff084a2c72495ba3616444a2c2338` |
| `bun --version` | `1.1.38` | comando executado no clone |
| `CHALLENGE_SPEC.md` vs README upstream | byte a byte idênticos | `curl -fsSL https://raw.githubusercontent.com/junglegaming/backend-challenge/main/README.md` seguido de `cmp -s`; ambos SHA-256 `47795fce2fc38cae5f1b91368ebaf80b7a2ed1fe147f36704b665faf0613812e` |
| `docker version` | BLOCKED | `bash: docker: command not found` |
| `docker compose version` | BLOCKED | `bash: docker: command not found` |

## Testes no SHA-base

Comando reproduzido sem alterações no código-base:

```text
bun test
Bun: 1.1.38
Resultado: 30 pass, 29 skip, 0 fail; 90 assertions; 59 testes em 19 arquivos
Exit code: 0
```

Os 29 skips incluem as specs PostgreSQL/concorrência/consumer/Outbox/HTTP e a spec LocalStack quando chamada sem as flags de integração. Um processo verde com `29 skip` não é evidência de aprovação dessas suites.

## GitHub Actions-base

- Run: [43751276240](https://github.com/RicardoSenna4/jungle-gaming-backend/actions/runs/43751276240)
- SHA: `688ba474e1bff084a2c72495ba3616444a2c2338`
- Conclusão geral: `success`.
- Job `verify`: typecheck, lint, format, build e `bun test`; o comando genérico reportou **30 pass / 29 skip / 0 fail**.
- Job `integration-services`: iniciou `postgres` e `localstack`, aguardou as filas, aplicou migrations e executou somente `RUN_INTEGRATION=1 RUN_SQS_REAL=1 bun test test/integration/sqs-localstack.spec.ts`; o job terminou com sucesso.
- Rollback executado: uma chamada de `bun run db:rollback`, correspondente a uma única migration, embora o snapshot contenha quatro arquivos `Migration*.ts`.
- Artefatos JUnit/log por suíte: não configurados no workflow-base.

## Limite de execução nesta sessão

Este sandbox não possui Docker. Por isso, não foram executados aqui testes PostgreSQL/LocalStack em containers. A suíte real deve rodar na branch F00/F01 em um runner GitHub Actions limpo, usando os serviços definidos em `docker-compose.yml`. Até que essa execução termine, o resultado do novo workflow é **PENDING**, não PASS.

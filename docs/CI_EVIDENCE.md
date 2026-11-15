# Evidência de integração contínua (CI)

Este documento é a **referência única** para compreender o que foi efetivamente executado no GitHub Actions e distinguir o resultado de um commit antigo do status do código entregue.

## 1. Verificar a versão atual antes de usar ou avaliar

1. Abra [Commits da branch principal](https://github.com/RicardoSenna4/jungle-gaming-backend/commits/main) e anote o **SHA completo do último commit**.
2. Abra o [workflow de CI filtrado para a main](https://github.com/RicardoSenna4/jungle-gaming-backend/actions/workflows/ci.yml?query=branch%3Amain).
3. Localize a execução desse **mesmo SHA** e confira se terminou em **Success**. Uma execução verde de outro commit não prova que a versão atual passou.
4. Dentro da execução, confira as etapas de typecheck, ESLint, Prettier, build, migrations, testes PostgreSQL, concorrência, SQS/LocalStack e smoke da API em Docker Compose. Consulte os logs caso haja falhas.

**Importante:** o [badge no README](../README.md) acompanha a branch, mas não substitui a conferência explícita do SHA. Nenhum número de testes apresentado em um snapshot histórico deve ser interpretado como resultado garantido de futuros commits.

## 2. Snapshot histórico verificado

| Campo | Valor |
|---|---|
| Data | 15 de novembro de 2026 |
| Commit do código testado | [3e540c6da0b7197ae1954c4315febd198a292b64](https://github.com/RicardoSenna4/jungle-gaming-backend/commit/3e540c6da0b7197ae1954c4315febd198a292b64) |
| Execução | [GitHub Actions #43770950239](https://github.com/RicardoSenna4/jungle-gaming-backend/actions/runs/43770950239) |
| Resultado | **Success** |
| Suítes obrigatórias | **80 testes, 0 falhas, 0 erros, 0 ignorados, 12 alvos** |
| Integrações | PostgreSQL e LocalStack/SQS reais em ambiente descartável |
| Build e migrations | Typecheck, lint, formatação, build Docker e migrations |
| Smoke | Aplicação executada em container; operações HTTP/SQS, ledger e reconciliação; reinício após SIGKILL/SIGTERM aprovado |

Esses dados foram verificados nos logs dessa execução. Esta tabela é deliberadamente **histórica**: qualquer commit posterior exige uma nova consulta ao Actions.

## 3. O que os testes não comprovam

- Execução física do projeto **no Windows**, em **WSL/Ubuntu** ou no **Git Bash**: os runners de CI são Linux. Para testar em sua máquina, siga o [guia de execução multiplataforma](DEMO.md).
- Interrupção provocada precisamente entre o envio SQS da Outbox e a marcação de publicação no SQL, ou durante o ACK da Inbox.
- Equivalência entre LocalStack e todos os comportamentos do SQS gerenciado em AWS.
- Autenticação real ou requisitos de produção explicitamente fora do escopo.

## 4. Como interpretar a documentação

Os documentos [README](../README.md), [Rastreabilidade](REQUIREMENTS_TRACEABILITY.md), [Testes](TESTING.md), [Auditoria](FINAL_DELIVERY_AUDIT.md) e [Checklist de entrega](DELIVERY_CHECKLIST.md) apontam para este arquivo em vez de manterem afirmações incompatíveis sobre qual commit é o mais recente.

Falhas de CI em commits intermediários permanecem como parte do histórico. A referência correta para entrega é **o último commit efetivamente submetido e sua execução correspondente**.

# Checklist de entrega — revisão final

Preencher PASS, FAIL ou BLOCKED ao **final**, indicando o SHA e a URL exata da CI.

| Gate | Critério | Estado |
|---|---|---|
| 01 | Bun 1.x, NestJS, TS strict, MikroORM, PG, SQS, Compose | PENDENTE CI final |
| 02 | Instalação limpa, build Docker e migrations up/down | PENDENTE CI final |
| 03 | Decimal exato, moeda e overflow no banco | PENDENTE CI final |
| 04 | Wallet, OPENING, ledger, versão | PENDENTE CI final |
| 05 | BET, WIN, LOSS, REFUND e ROLLBACK | PENDENTE CI final |
| 06 | Hash e replay da resposta original | PENDENTE CI final |
| 07 | 50 chamadas idênticas em paralelo | PENDENTE CI final |
| 08 | 80 + 80 sobre saldo 100 | PENDENTE CI final |
| 09 | ≥3 processos e wallets distintas | PENDENTE CI final |
| 10 | Worker agendado e referência fora de ordem | PENDENTE CI final |
| 11 | Inbox, ACK após commit, DLQ e redelivery | PENDENTE validação |
| 12 | Outbox real, claim concorrente, eventId e recuperação | PENDENTE validação |
| 13 | Eventos versionados e publicação pós-commit | PENDENTE CI final |
| 14 | API, cursor, HTTP 400/409/422/202/503 | PENDENTE CI final |
| 15 | Health, logs, métricas e reconciliação | PENDENTE CI final |
| 16 | CI no SHA final sem skips obrigatórios | PENDENTE CI final |
| 17 | README, ARCHITECTURE, docs e links reais | PENDENTE revisão |
| 18 | Sem credenciais reais ou segredos no Git | PENDENTE revisão |
| 19 | Acesso da banca ao repositório privado | PENDENTE — proprietário |
| 20 | Revisão humana e submissão oficial | PENDENTE — proprietário |

**Falha eliminatória encontrada em qualquer gate:** não marcar pronto.
**Aprovação humana:** necessária independentemente da CI.

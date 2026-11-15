# Roteiro de demonstração (10–15 minutos)

Execute apenas com **dados fictícios e ambiente de desenvolvimento isolado**.

## Subir aplicação

~~~bash
docker compose up --build -d
curl http://localhost:3000/health/ready
~~~

Para os comandos abaixo, use Bash/WSL/Git Bash com `curl` e `jq`.

~~~bash
BASE=http://localhost:3000
PLAYER="demo-$(date +%s)"
PROVIDER="provider-$PLAYER"
WALLET=$(curl -fsS "$BASE/wallets" -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}")
WALLET_ID=$(printf '%s' "$WALLET" | jq -r .id)
echo "$WALLET" | jq .

BET=$(jq -nc --arg p "$PLAYER" --arg v "$PROVIDER" --arg w "$WALLET_ID" \
  '{providerId:$v,externalTransactionId:"demo-bet",playerId:$p,walletId:$w,
   roundId:"round-1",gameId:"game-1",kind:"BET",
   money:{amount:"25.00",currency:"BRL"}}')

# BET -> saldo 75.00
curl -fsS "$BASE/wagering/transactions" -H 'content-type: application/json' \
  -H 'Idempotency-Key: demo-bet-key' -d "$BET" | jq .
# Replay -> saldo original 75.00, idempotentReplay true
curl -fsS "$BASE/wagering/transactions" -H 'content-type: application/json' \
  -H 'Idempotency-Key: demo-bet-key' -d "$BET" | jq .

REFUND=$(jq -nc --arg p "$PLAYER" --arg v "$PROVIDER" --arg w "$WALLET_ID" \
  '{providerId:$v,externalTransactionId:"demo-refund",playerId:$p,walletId:$w,
   roundId:"round-1",gameId:"game-1",kind:"REFUND",
   referenceExternalTransactionId:"demo-bet",
   money:{amount:"25.00",currency:"BRL"}}')
curl -fsS "$BASE/wagering/transactions" -H 'content-type: application/json' \
  -H 'Idempotency-Key: demo-refund-key' -d "$REFUND" | jq .
curl -fsS "$BASE/wallets/$WALLET_ID" | jq .
curl -fsS "$BASE/wallets/$WALLET_ID/ledger?limit=20" | jq .
curl -fsS -X POST "$BASE/wallets/$WALLET_ID/reconciliation" | jq .
~~~

**Esperado:** `OPENING` 100.00; BET debita 25.00, replay não altera o saldo; REFUND credita 25.00; ledger contém 3 movimentos e reconciliação `consistent:true`.

## Ensaios críticos já automatizados

| Exercício | Comando de teste (em banco descartável) | Evidência |
|---|---|---|
| 80 + 80 sobre 100 | `bun run test:concurrency` | [A](../test/integration/concurrency.spec.ts) |
| 50 replays concorrentes | `bun run test:concurrency` | [B](../test/integration/concurrency.spec.ts) |
| Três processos | `bun run test:concurrency` | [D](../test/integration/concurrency.spec.ts) |
| Referência antes da origem | `bun run test:integration:postgres` | [Pending](../test/integration/pending-worker.spec.ts) |
| Inbox, SQS, redelivery, DLQ | `bun run test:integration:sqs` | [SQS](../test/integration/sqs-localstack.spec.ts) |
| Outbox e falhas | `bun run test:recovery` | [Outbox](../test/integration/outbox-publisher.spec.ts) |

Essas suites usam limpeza de fixtures com `TRUNCATE` e **não devem ser executadas sobre o mesmo banco com dados a preservar**. Para validar a partir de um clone limpo, siga [TESTING](TESTING.md).

### Teste real de reinicialização

~~~bash
# Apenas em Compose isolado e descartável
docker compose up --build -d
SMOKE_ALLOW_DISRUPTION=1 bun run smoke:compose
~~~

O script [`scripts/smoke-compose.ts`](../scripts/smoke-compose.ts) processa HTTP + SQS, consome mensagens da fila de eventos e encerra/reinicia o container `api` com SIGKILL/SIGTERM. **Não execute em produção ou em ambiente compartilhado.** [Execução verificada no CI](https://github.com/RicardoSenna4/jungle-gaming-backend/actions/runs/43767143661).

## Apresentação em 10–15 minutos

| Tempo | Assunto |
|---|---|
| 0–2 min | Problema, arquitetura e invariantes |
| 2–4 min | Money, wallet, ledger e migrations |
| 4–6 min | Lock por wallet, 80+80 e 50 replays |
| 6–9 min | Inbox/SQS, outbox, eventos e falhas |
| 9–12 min | CI real, SIGKILL/SIGTERM e reconciliação |
| 12–15 min | ADRs, limitações e perguntas |

Explique por que a garantia é **at-least-once**, por que SQS FIFO não substitui idempotência SQL e como o ledger é usado na reconciliação. Consulte [arquitetura](../ARCHITECTURE.md), [ADRs](02_ADR_REGISTER.md) e [checklist humano](DELIVERY_CHECKLIST.md).

## Passos exclusivos do proprietário

Conferir clone limpo em sua máquina, permissões/visibilidade, política de entrega e uso de IA, revisão dos commits e envio ao recrutador. O CI verde não conclui essas ações.

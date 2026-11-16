# API — contratos e exemplos

**Fonte:** [controllers](../src/interfaces/http/app.controller.ts), [wallet controller](../src/interfaces/http/wallet.controller.ts), [DTOs](../src/interfaces/http/dtos.ts). Base local: `http://localhost:3000`.

**Money:** valores em string decimal com exatamente duas casas e moeda de três letras maiúsculas: `{"amount":"25.00","currency":"BRL"}`. Não enviar números JSON para dinheiro. `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK` utilizam montantes positivos.

| Método | Endpoint                                                              | Resposta esperada                             |
| ------ | --------------------------------------------------------------------- | --------------------------------------------- |
| `POST` | `/wallets`                                                            | 201, wallet                                   |
| `GET`  | `/wallets/:walletId`                                                  | 200, wallet                                   |
| `GET`  | `/wallets/:walletId/ledger?limit=50&cursor=...`                       | 200, itens e nextCursor                       |
| `POST` | `/wagering/transactions`                                              | 200 processada / 202 pendente / 422 rejeitada |
| `GET`  | `/wagering/transactions/:transactionId`                               | 200 ou 404                                    |
| `GET`  | `/providers/:providerId/wagering/transactions/:externalTransactionId` | 200 ou 404                                    |
| `POST` | `/wallets/:walletId/reconciliation`                                   | 200                                           |
| `GET`  | `/operations/quarantine`                                              | 200, registros operacionais                   |
| `POST` | `/operations/quarantine/:consumerName/:messageId/resolve`             | 200 ou 404                                    |
| `GET`  | `/health/live`                                                        | 200                                           |
| `GET`  | `/health/ready`                                                       | 200 ou 503                                    |
| `GET`  | `/metrics`                                                            | 200, Prometheus text/plain                    |

## 1. Wallet

```http
POST /wallets
Content-Type: application/json

{
  "playerId": "demo-player-1",
  "initialBalance": {"amount":"100.00","currency":"BRL"}
}
```

Exemplo ilustrativo de resposta `201`:

```json
{
  "id": "11111111-1111-4111-8111-111111111111",
  "playerId": "demo-player-1",
  "balance": { "amount": "100.00", "currency": "BRL" },
  "version": 1
}
```

Saldo inicial positivo produz transação interna `OPENING` e lançamento `CREDIT` no mesmo commit. Wallet duplicada por jogador/moeda: `409`.

## 2. Transação financeira

```http
POST /wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-a:bet-1

{
  "providerId": "provider-a",
  "externalTransactionId": "bet-1",
  "playerId": "demo-player-1",
  "walletId": "11111111-1111-4111-8111-111111111111",
  "roundId": "round-1",
  "gameId": "game-1",
  "kind": "BET",
  "money": {"amount":"25.00","currency":"BRL"}
}
```

Exemplo ilustrativo de resposta `200`:

```json
{
  "transactionId": "22222222-2222-4222-8222-222222222222",
  "status": "PROCESSED",
  "balance": { "amount": "75.00", "currency": "BRL" },
  "idempotentReplay": false
}
```

Repetição com a **mesma chave e payload** retorna o mesmo resultado financeiro e o saldo observado originalmente, com `idempotentReplay:true`; não cria novo débito. Chave igual/payload diferente: `409 IDEMPOTENCY_PAYLOAD_CONFLICT`. Rejeição de negócio (`INSUFFICIENT_FUNDS`, por exemplo): `422` inclusive no replay.

`FAILED` é reservado para falha operacional/permanente, sempre com
`failureCode` e sem movimento financeiro. No SQS, uma mensagem inválida ou
permanentemente inconsistente é persistida em quarentena antes do ACK; uma
falha transitória permanece sem ACK para retry/DLQ.

Para `REFUND` ou `ROLLBACK` inclua `referenceExternalTransactionId` e valor integral, no mesmo contexto de provedor, jogador, wallet, moeda e rodada. Referência ausente produz `PENDING_REFERENCE` / `202`, resolvida por worker ou expirada por política documentada.

## 3. Consultas e reconciliação

- `GET /wallets/:walletId/ledger`: `limit` padrão 50, permitido 1–100; `nextCursor` opaco; inválido retorna `400`. Itens contêm `direction`, `amount`, `balanceBefore`, `balanceAfter` e `transactionId`.
- Consultas de transações retornam identidades interna/externa, wallet, money, status e failureCode ou referência, quando aplicável.
- `POST /wallets/:walletId/reconciliation` retorna `storedBalance`, `calculatedBalance`, `difference`, `consistent`, `checkedEntries`. Divergência é sinalizada; **não** corrigida automaticamente.

## 4. Códigos de retorno

| HTTP    | Caso                                                    |
| ------- | ------------------------------------------------------- |
| **400** | DTO inválido ou falta de `Idempotency-Key`              |
| **404** | Transação/wallet inexistente                            |
| **409** | Conflito de idempotência ou unicidade                   |
| **422** | Rejeição financeira                                     |
| **202** | `PENDING_REFERENCE`                                     |
| **503** | Dependência indisponível (`retryable` quando aplicável) |

Há variantes de corpos de erro do NestJS, incluindo `errorCode`, `statusCode` e `message`. Veja [testes de contrato HTTP](../test/integration/http-api.spec.ts).

## 5. SQS e eventos

Fila de comandos: `wager-transactions.fifo`; DLQ: `wager-transactions-dlq.fifo`; saída: `wager-events.fifo`.

Envelope aceito, com IDs fictícios:

```json
{
  "messageId": "message-1",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-11-15T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "bet-1",
    "idempotencyKey": "provider-a:bet-1",
    "playerId": "demo-player-1",
    "walletId": "11111111-1111-4111-8111-111111111111",
    "roundId": "round-1",
    "gameId": "game-1",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

O consumer usa o mesmo caso de uso financeiro que a API. `Inbox` e efeito financeiro persistem no mesmo commit, e o ACK vem depois. A `Outbox` publica eventos concretos versionados com `eventId` estável; o consumidor downstream deve ser idempotente.

Operadores autenticados consultam `GET /operations/quarantine` e registram a
resolução com `POST /operations/quarantine/:consumerName/:messageId/resolve`.
O payload bruto é mantido apenas para auditoria operacional e não deve ser
exposto a usuários finais.

[Fluxos de falha e DLQ](FAILURE_RECOVERY.md) · [LocalStack E2E](../test/integration/sqs-localstack.spec.ts).

**Escopo de segurança:** com `AUTH_MODE=oidc`, as rotas de negócio e operação
exigem JWT OIDC validado por JWKS; health e métricas permanecem públicos. O modo
`challenge` é permissivo apenas para desenvolvimento/teste e não deve ser
exposto publicamente.

# Jungle Distributed Wagering Processor

Implementação do desafio técnico **Jungle Gaming — Distributed Wagering Processor**.
O [enunciado original](CHALLENGE_SPEC.md) permanece preservado.

**Stack:** Bun 1.1.38 · TypeScript strict · NestJS · MikroORM · PostgreSQL 16 · AWS SQS (LocalStack) · Docker Compose.

## Comece aqui — ambiente reproduzível

**Opção A — aplicação e infraestrutura em Docker Compose:**

```bash
docker compose up --build -d
docker compose ps
curl http://localhost:3000/health/live
curl http://localhost:3000/health/ready
```

O serviço `api` aplica as migrations no início e ativa consumer, outbox e worker de referências.
Aguarde o PostgreSQL e a inicialização das filas do LocalStack. Este ambiente é **apenas de desenvolvimento**; credenciais locais `test` e `postgres` não são adequadas para produção.

**Opção B — aplicação no host com Bun, infraestrutura no Compose:**

```bash
cp .env.example .env
bun install --frozen-lockfile
docker compose up -d postgres localstack
bun run db:migrate
bun run build
ENABLE_SQS_CONSUMER=true ENABLE_OUTBOX_PUBLISHER=true bun run start:bun
```

Use a Opção A **ou** a Opção B, não duas aplicações na porta 3000 ao mesmo tempo.

## Arquitetura e garantias financeiras

- Dinheiro imutável, string decimal com duas casas, aritmética `decimal.js` e persistência exata `NUMERIC(20,2)`; nunca `number` para montantes.
- A wallet é a unidade de concorrência: bloqueio `SELECT FOR UPDATE` por linha, sem lock global.
- `BET` debita, `WIN` credita e `LOSS` não altera saldo ou ledger. `REFUND` e `ROLLBACK` validam referência, moeda, valor integral e contexto.
- Índices únicos persistentes e hash SHA-256 canônico protegem idempotência; replay devolve o saldo observado na operação original.
- Crédito `OPENING` e cada movimento de saldo possuem lançamento no ledger. O PostgreSQL impede UPDATE/DELETE no ledger por trigger.
- Entrada SQS via Inbox transacional; ACK somente após commit, com redelivery, backoff e DLQ.
- Eventos são gravados na mesma transação SQL e publicados depois por Outbox, com `FOR UPDATE SKIP LOCKED`, leases e `eventId`. A garantia é **at-least-once**, não exactly-once.
- Referências ausentes ficam `PENDING_REFERENCE` e um worker as resolve ou rejeita por TTL/limite de tentativas.
- Reconciliação detecta diferenças entre saldo armazenado e soma do ledger; não corrige silenciosamente.

[Decisões arquiteturais](ARCHITECTURE.md) · [Recuperação de falhas](docs/FAILURE_RECOVERY.md) · [Matriz oficial de requisitos](docs/REQUIREMENTS_TRACEABILITY.md)

## Endpoints

| Método | Rota | Finalidade |
|---|---|---|
| POST | `/wallets` | Criação e crédito inicial |
| GET | `/wallets/:walletId` | Consulta de saldo/version |
| GET | `/wallets/:walletId/ledger?limit=50&cursor=...` | Ledger com cursor opaco |
| POST | `/wagering/transactions` | Envio financeiro; requer `Idempotency-Key` |
| GET | `/wagering/transactions/:transactionId` | Consulta por ID interno |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta pela identidade no provedor |
| POST | `/wallets/:walletId/reconciliation` | Comparação materializado/ledger |
| GET | `/health/live` | Liveness |
| GET | `/health/ready` | PostgreSQL e SQS disponíveis |
| GET | `/metrics` | Prometheus por instância |

**Exemplo BET:**

```bash
curl -X POST http://localhost:3000/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:bet-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"bet-1","playerId":"SEU_PLAYER_ID","walletId":"UUID_DA_WALLET","roundId":"round-1","gameId":"game-1","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

Crie a wallet primeiro via `POST /wallets` e substitua os marcadores pelos dados retornados e pelo `playerId` escolhido.

## Qualidade e testes

```bash
bun run typecheck
bun run lint
bun run format:check
bun run build
bun run test:unit
bun run test:integration:postgres
bun run test:integration:sqs
bun run test:concurrency
bun run test:recovery
bun run test:all
bun run db:migration:check
```

Para as integrações, inicie PostgreSQL e LocalStack antes dos testes e aplique as migrations.
Os scripts isolam suítes que usam TRUNCATE e recusam relatórios JUnit com **zero testes ou skips**.
A CI executa os mesmos comandos em runner descartável, incluindo LocalStack real,
concorrência multiprocessos e rollback da cadeia de migrations.

**Acompanhe o SHA enviado**, não apenas um badge verde de commit anterior:
[GitHub Actions](https://github.com/RicardoSenna4/jungle-gaming-backend/actions).
Os resultados, limitações e como reproduzi-los estão em [TESTING.md](docs/TESTING.md).

## Cenários de avaliação prioritários

1. Wallet 100.00 + duas BETs concorrentes de 80.00: uma PROCESSED, uma REJECTED, saldo 20.00, um débito.
2. 50 reenvios simultâneos idênticos: uma única movimentação e 49 replays.
3. Três processos independentes sobre uma wallet e wallets diferentes em paralelo.
4. REFUND/ROLLBACK concorrentes, fora de ordem e com saldo insuficiente.
5. Worker reiniciado depois do commit/pré-ACK; Inbox mantém uma única movimentação.
6. Commit financeiro seguido de queda antes do publish; Outbox recupera o evento.
7. Ledger append-only, migrations, health, métricas e reconciliação.

As assertions e o status de execução por cenário estão detalhados em [TESTING.md](docs/TESTING.md) e na [matriz de rastreabilidade](docs/REQUIREMENTS_TRACEABILITY.md).

## Autenticação e limitações declaradas

O desafio **permite não implementar autenticação**. A aplicação não possui validação OIDC;
`ChallengeProviderIdentityGuard` é um ponto de extensão **no-op explícito**, não um mecanismo de segurança.
Em produção seria necessário IdP externo, autorização e validação de identidade do provedor.
Health permanece público. Mensagens SQS usam canal interno confiável, com validação de envelope/provedor.

A entrega não é produção: não inclui gestão de segredos, operação em AWS real,
deduplicador downstream de produção, observabilidade centralizada nem provisionamento de alta disponibilidade.
Consulte [limitações e verificações pendentes](docs/OPEN_ISSUES.md).

## Outros documentos

- [Arquitetura e trade-offs](ARCHITECTURE.md)
- [Matriz de requisitos e testes](docs/REQUIREMENTS_TRACEABILITY.md)
- [Testes e evidências](docs/TESTING.md)
- [Falhas e recuperação](docs/FAILURE_RECOVERY.md)
- [ADRs](docs/02_ADR_REGISTER.md)
- [Checklist de entrega](docs/DELIVERY_CHECKLIST.md)
- [Enunciado original](CHALLENGE_SPEC.md)

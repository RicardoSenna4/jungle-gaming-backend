# Arquitetura e estado da implementação

## Stack e limites

A aplicação é um monólito modular NestJS em Bun/TypeScript, com MikroORM e PostgreSQL. MikroORM é a única estratégia ativa de mapeamento e migrations. O código TypeORM legado foi removido para evitar caminhos divergentes de persistência. O domínio monetário recebe e serializa strings decimais com escala fixa de duas casas; `decimal.js` é usado para aritmética. Nenhum valor monetário passa por `number`.

Autenticação está fora do escopo implementado, conforme permitido pelo enunciado. Os endpoints HTTP não estão autenticados e a fila é tratada como canal interno confiável; antes de produção, integrar IdP OIDC e validar identidade/allowlist de cada provedor.

## Consistência financeira

A wallet é a unidade de concorrência. O caso de uso bloqueia a linha da wallet com `SELECT ... FOR UPDATE`, valida contexto/moeda/saldo e persiste transação, alteração de saldo, ledger, outbox e Inbox (quando aplicável) dentro da mesma transação SQL. Índices únicos, `CHECK(balance >= 0)`, checks aritméticos do ledger e trigger append-only protegem invariantes no PostgreSQL. Wallets diferentes não compartilham lock global.

A idempotência durável é por `(providerId, idempotencyKey)` e `(providerId, externalTransactionId)`. O payload de negócio é canonizado e hasheado em SHA-256. Reuso da chave com hash diferente é conflito; replay idêntico devolve o snapshot salvo sem repetir efeitos. O saldo inicial positivo cria `OPENING` e um crédito de ledger atomicamente.

## Mensageria e recuperação

O consumer da fila `wager-transactions.fifo` usa Inbox única por `(consumerName,messageId)` e chama o mesmo `WagerProcessingService` do HTTP. A confirmação SQS ocorre somente após o commit SQL. A redrive policy da fila de comandos encaminha mensagens que não podem ser confirmadas para `wager-transactions-dlq.fifo`. O shutdown interrompe polling e drena operações em andamento.

Eventos são inseridos na Outbox na transação financeira. `OutboxPublisherWorker` seleciona lotes com `FOR UPDATE SKIP LOCKED`, define `claim_token` e lease, publica fora da transação na fila `wager-events.fifo` e só então marca `published_at`. Falhas liberam a lease e agendam retry exponencial limitado a cinco minutos entre tentativas. Se o processo cair depois do envio e antes da marcação SQL, o evento pode ser reenviado; o contrato é at-least-once e consumidores devem deduplicar por `eventId`.

Referências de REFUND/ROLLBACK ausentes ficam em `PENDING_REFERENCE`; o worker reprocessa com backoff e TTL/limite de tentativas. A expiração persiste rejeição auditável, evento e failure code sem mover saldo.

## Consultas, saúde e observabilidade

O ledger é consultável por cursor estável e opaco. A reconciliação compara, em uma única consulta PostgreSQL, o saldo materializado com a soma de créditos menos débitos e o número de lançamentos verificados. Ela retorna divergências e não corrige saldo automaticamente.

`/health/live` reporta somente a vida do processo. `/health/ready` testa a conexão PostgreSQL e as filas SQS de comando e evento, retornando 503 se alguma dependência estiver indisponível. `/metrics` expõe contadores, gauges e histogramas no formato Prometheus por processo; o Prometheus deve agregar instâncias. Os logs de processamento são JSON e não incluem payload monetário.

## Validação atual

- Typecheck, lint, format check, build e migrations MikroORM: aprovados; migration check sem pendências.
- 30 testes unitários aprovados.
- 25 testes de integração PostgreSQL aprovados, inclusive concorrência `SKIP LOCKED` entre publishers e divergência detectada pela reconciliação.
- 1 teste end-to-end LocalStack SQS ficou pulado. Docker/LocalStack não estão disponíveis neste sandbox, então esse gate permanece pendente e não é tratado como aprovado.

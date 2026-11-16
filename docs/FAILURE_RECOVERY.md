# FAILURE RECOVERY — Contratos de falha

## Commit SQL e Inbox

1. O consumer valida o envelope e chama o mesmo use case do HTTP.
2. Em um único commit PostgreSQL, registra Inbox, transação financeira,
   wallet/ledger (quando aplicável) e eventos na Outbox.
3. Apenas depois do commit o consumer envia ACK/`DeleteMessage` ao SQS.
4. Se morrer antes do commit, não há movimento parcial. Se morrer depois
   do commit e antes do ACK, o redelivery encontra idempotência e Inbox
   já persistidas, sem novo débito/crédito.

O SQS não faz parte da transação PostgreSQL; usar FIFO não é suficiente.
A política de redrive da fila conduz mensagens irrecuperáveis para a DLQ,
e uma visibilidade exponencialmente ajustada reduz retries agressivos.

## Outbox

1. O commit grava o evento com `eventId` durável, nunca publica diretamente.
2. Publisher concorrente reclama lote com `FOR UPDATE SKIP LOCKED` e lease/token.
3. Envia ao SQS e marca `published_at` após confirmação.
4. Queda antes do send: outra instância reclama após a lease e publica.
5. Queda depois do send/pré-marcação: pode publicar de novo com mesmo `eventId`;
   downstream deve deduplicar. A garantia **não é exactly-once**.

Erro temporário de SQS provoca retry com `next_attempt_at` e backoff.
Um evento poison permanece rastreável na Outbox com `attempts` e lag,
não desaparece sem sinal.

## Referências fora de ordem

`REFUND` e `ROLLBACK` podem chegar antes da origem. A transação fica
`PENDING_REFERENCE` com relógio/tentativas persistidos; o timer cria
contexto MikroORM independente e reprocessa pelo mesmo use case.
Quando a referência aparece, a operação é aplicada uma vez.
TTL ou tentativas esgotados levam a `REJECTED` e evento correspondente.

## FAILED e quarentena operacional

`FAILED` é um estado terminal de falha operacional/permanente, distinto de
`REJECTED` (regra de negócio) e de `PENDING_REFERENCE` (falha recuperável de
ordem temporal). Nenhum caminho para `FAILED` pode alterar wallet ou ledger.
Uma transação `FAILED` deve carregar `failureCode`, `processedAt`, snapshot de
resposta e evento de estado; replays retornam esse snapshot sem novo efeito.

Mensagens SQS que não formam um envelope válido, ou que falham por erro
permanente de contrato/idempotência, seguem este fluxo:

1. o consumer grava `message_quarantine` em uma transação PostgreSQL, com
   `messageId`, consumer, payload bruto, motivo, contador e timestamps;
2. somente depois do commit confirma o ACK SQS;
3. o resultado operacional é `FAILED` com `failureCode`, sem Inbox, wager ou
   lançamento no ledger;
4. se PostgreSQL estiver indisponível, não há ACK: a mensagem permanece em
   retry e pode chegar à DLQ;
5. o operador consulta `GET /operations/quarantine` e resolve o registro com
   `POST /operations/quarantine/:consumerName/:messageId/resolve`, sempre com
   uma nota auditável.

Falhas transitórias (PostgreSQL indisponível, timeout ou erro HTTP 5xx) nunca
são convertidas automaticamente em `FAILED`: permanecem sem ACK e usam o
`VisibilityTimeout`/redrive da fila. Quarentena é uma decisão terminal
durável; DLQ continua sendo o isolamento de mensagens que não puderam ser
registradas ou reprocessadas.

## Shutdown e visibilidade

No desligamento, o consumer deixa de consultar novas mensagens e espera
as tarefas em voo. Mensagens que não receberam ACK retornam após a visibilidade.
O publisher espera o lote em execução; claims não concluídas expiram.
A idempotência do banco continua a última linha de defesa.

## Limites de validação

Diferenciar tests com falha de envio simulada de `kill -9` real.
O gate final requer também comprovação do comportamento de reinicialização,
redrive/DLQ e transições pendentes executadas por timer, e não só por chamadas
manuais a métodos internos.

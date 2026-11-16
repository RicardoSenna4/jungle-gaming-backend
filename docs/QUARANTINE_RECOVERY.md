# Quarentena: investigação, disposição e redrive manual

Quarentena durável antes do ACK e retry/DLQ para falhas transitórias continuam
inalterados. Redrive não é resolução e envio ao SQS não comprova processamento.
Todas as rotas exigem em OIDC papel operacional/admin, permission JWT da ação e
grant persistido issuer/subject. `quarantine.redrive` / scope `quarantine:redrive`
é separado de read/resolve; não é concedido automaticamente a administradores.

## Consulta e investigação

- GET `/operations/quarantine` preserva a listagem legada limitada.
- GET `/operations/quarantine/page?limit=50&status=OPEN&consumer=...&reason=...`
  retorna `{items,nextCursor?}`; continue com o cursor opaco. Limite 1–100,
  ordenação estável por last_seen_at (microssegundos), consumer/message em DESC.
  Cursor é uma visão móvel: novas recepções podem mudar last_seen_at; não é snapshot
  congelado de uma investigação. IDs não concedem acesso.
- GET `/operations/quarantine/:consumerName/:messageId/redrives` retorna as últimas
  100 tentativas e 100 eventos, com ator, horário, justificativa e resultado.
  Não retorna payload nem destino SQS. Auditoria completa permanece no PostgreSQL.

A origem por provider não é inferida do JSON inválido. Delegação continua global
explícita da ADR-019. Leia notas/justificativas apenas em canais administrativos
restritos; não inclua tokens/credenciais na justificativa. Logs não copiam payloads,
notas ou respostas brutas de dependências.

## Disposição sem reprocessamento

POST `.../:consumerName/:messageId/resolve` com `{ "note": "justificativa" }`.
Nota não vazia, até 1024 caracteres, obrigatória. Atualiza RESOLVED e grava evento
com ator e timestamp; não envia mensagem. Tentativa REDRIVING bloqueia resolução
(409), inclusive se lease expirou: primeiro recupere a tentativa pendente.
Um novo recebimento real pode reabrir o registro; o evento de resolução permanece
no histórico, mesmo se os campos de disposição atuais forem reiniciados.

## Redrive autorizado

POST `.../:consumerName/:messageId/redrive`, header `Idempotency-Key` (1–128 chars),
body `{ "justification": "investigação aprovada" }`. Somente payload armazenado,
inalterado, válido segundo o contrato atual e do consumer configurado é aceito.
Não corrige JSON/valores/identidades implicitamente. Malformados retornam 422;
correção exige comando legítimo da origem e disposição do registro antigo.

OPEN → REDRIVING após claim persistido. A tentativa guarda snapshot do payload,
fila configurada, identidade idempotente do request, UUID de dedup, ator,
justificativa e lease de 60 segundos. O banco decide expiração do lease; o relógio
do servidor HTTP não decide posse. Mesmo request key é idempotente; outra key em
REDRIVING/RELEASED/RESOLVED recebe 409, sem nova publicação. Publicação usa fila
persistida a partir da configuração do servidor, nunca URL vinda do request.

- Send confirmado + commit do resultado: tentativa SENT, registro RELEASED (201).
- Falha de send: tentativa FAILED, registro OPEN, HTTP 503. Retry da mesma key
  preserva o resultado; nova tentativa exige nova key e nova ação autorizada.
- Falha antes de persistir claim: 503 e nenhuma publicação.
- Send pode ter ocorrido, mas resultado SQL não foi confirmado: 503
  `REDRIVE_RESULT_UNKNOWN`; estado PENDING/REDRIVING permanece durável.

RELEASED significa entregue ao broker, não sucesso financeiro. Confira transação,
Inbox e ledger para confirmar processamento; divergências nunca são autocorrigidas.

## Recuperar resultado incerto / reinicialização

1. Consulte histórico e a tentativa original; preserve Idempotency-Key.
2. Aguarde o lease expirar no banco (60s desde a última aquisição).
3. Com a permissão vigente, envie novamente a MESMA key, com justificativa de recuperação.
4. A tentativa original é retomada com novo lease_token. Resultado de um worker
   antigo não pode sobrescrever o lease atual. Dedup SQS usa o MESMO UUID persistido.
5. Confira SENT/RELEASED e, separadamente, resultado financeiro/Inbox/ledger.

Publicação é at-least-once: timeout de rede não prova ausência de envio. Depois da
janela FIFO, duplicatas também continuam possíveis. O envelope e seus messageId,
provider/key/externalId são preservados, para Inbox/idempotência persistentes
impedirem duplicação financeira. Não criar nova identidade financeira para "corrigir"
um redrive. Não há timer de redrive automático após restart: recuperação é manual,
autorizada e auditada; nenhum processo em memória é fonte da verdade.

## Schema, rollback e evidências

Migration20261116130000 amplia status/permissões e cria attempts + operation_events,
com FK, unicidade consumer/message/request-key e histórico append-only. Não altera
Money, wallets, ledger, Inbox/Outbox ou regras financeiras. Rollback recusa REDRIVING
até recuperação; dados/grants novos exigem backup verificado e confirmação
`QUARANTINE_ROLLBACK_BACKUP_CONFIRMED=1`. Somente então os objetos/grants específicos
novos são removidos, mantendo auditoria antiga e disposições legadas. CI exporta
também essas tabelas antes de rollback em banco descartável. Não usar down para
cancelar envio que pode já ter ocorrido.

Os testes obrigatórios usam PG/LocalStack reais, triggers SQL para falhas de claim
ou pós-envio, duplicata financeira, concorrência e processo Node novo para retomar
resultado incerto. O teste expira lease no banco para abreviar a espera; isso não
é um procedimento operacional para forçar recuperação de worker ainda ativo.

Claim e finalização adquirem locks na mesma ordem (quarentena → tentativa),
inclusive em retries simultâneos. A suíte valida quatro requisições concorrentes
para a mesma key, sem aceitar 503/deadlock como resultado de concorrência normal.

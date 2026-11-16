# Consumidor didático de referência

Não é conectado ao AppModule nem altera wallet/ledger. Configure banco separado
REFERENCE_DATABASE_URL e fila de eventos REFERENCE_QUEUE_URL. Instalação do schema
reference_events é opt-in REFERENCE_INSTALL_SCHEMA=1; execute com Bun run.ts.
Não use credenciais/DB de produção para experimentar. Em AWS, configure região,
IAM e DLQ no broker; SQS_ENDPOINT/dummy credentials são somente para emulador local.

Valida tipo, versão 1, eventId UUID, data, aggregate/correlation e timestamp.
Processados e efeito didático (uma linha de projeção por evento) são atômicos na
mesma transação PG. PK eventId arbitra processos concorrentes. ACK só após commit;
falha de ACK/redelivery não duplica efeito. Invalid input é registrado antes de ACK;
erro SQL/transitório não recebe ACK. Conflito de payload pelo mesmo ID é recusado
sem efeito e segue retry/DLQ configurado no broker para investigação. Não imprimir
payload/credenciais nos logs. Banco único por consumer não aceita chamadas paralelas
na mesma conexão; cada processo possui sua própria conexão.

Garantia at-least-once de entrega, com efeito local deduplicado transacionalmente;
não exactly-once fim a fim. Chamadas externas/email não entram nessa transação e
exigiriam outra Outbox. Retenção da tabela processed precisa cobrir a janela de
replay; apagar IDs reabre risco de efeitos repetidos. A projeção é propositalmente
mínima e não é implementação de contabilidade ou consumidor de produção completo.

Testes obrigatórios: mensagens reais duplicadas, concorrência de três conexões,
SQL rollback/invalid input e processo independente morto por SIGKILL após commit
antes de ACK, seguido de redelivery sem segundo efeito.

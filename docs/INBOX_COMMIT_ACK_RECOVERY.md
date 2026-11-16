# Prova de recuperação entre commit da Inbox e ACK

O spec obrigatório `inbox-commit-ack.spec.ts` executa o consumer real em processos
Bun independentes, PostgreSQL e LocalStack reais. Não usa relógio falso, mock de
SQS/SQL, exceção no lugar de morte de processo ou apenas restart da API.

## Sequência verificada

1. Cria banco e duas filas FIFO descartáveis exclusivos do run.
2. Abre wallet de 100.00 BRL e publica uma BET válida de 25.00 com identidades fixas.
3. Primeiro processo usa o pollLoop/handleMessage reais. No limite anterior ao
   DeleteMessage, um subclass de teste emite checkpoint e aguarda indefinidamente.
4. O processo pai consulta por outra conexão PG e observa commit real: saldo 75.00,
   versão 2, uma BET PROCESSED, uma Inbox processada e dois lançamentos (OPENING/BET).
5. Pai envia SIGKILL e confirma o sinal de saída do filho: nenhum shutdown gracioso/ACK.
6. Aguarda 3.2 segundos para expiração REAL da visibilidade configurada em 3 segundos.
7. Um novo processo/novo ORM/novo consumer recebe o MESMO brokerMessageId com
   ApproximateReceiveCount >= 2 e confirma DeleteMessage no SQS real.
8. Snapshot de wallet/transação/Inbox/ledger/Outbox é idêntico ao commit observado;
   fila vazia após ACK. Não se infere ausência de duplicata apenas do saldo.

O ACK de produção foi isolado num método protegido com o mesmo Send DeleteMessage
e métrica já existentes, sem condição de pause/failpoint ou flag de ambiente.
Somente o subclass em `test/fixtures/inbox-ack-worker.ts` contém a pausa. Ele exige
NODE_ENV=test, database/run ID exatos, host de PG/endpoint SQS locais, fila do run e
credenciais dummy do emulador. `.dockerignore` exclui test/ da imagem: não há fixture
nem toggle de falha para habilitar no runtime de produção. Não executar esse
harness em bancos/filas compartilhados ou dados reais.

## Runner, CI e evidência

Target `inbox-commit-ack` faz parte de all, sqs e recovery, com RUN_INTEGRATION e
RUN_SQS_REAL. O CI executa `test:all` e publica `.test-results/`, incluindo JUnit/log
do target e `inbox-commit-ack-evidence.json`. Não há skip permitido pelo runner.

A evidência registra sinal, PIDs, receive counts, estado financeiro observado,
contagens e hashes SHA-256 dos três arquivos exercitados. `baseCommit`/workingTreeDirty
indicam se a validação ocorreu antes de commit; não apresentar baseCommit como SHA
de código limpo se dirty=true. CI num checkout limpo registrará seu próprio SHA.
Não há token, credencial ou payload financeiro de cliente nesse artefato: dados
são sintéticos em banco exclusivo que é removido após o teste.

A prova cobre a janela pós-commit/pré-ACK da Inbox. Ela não comprova automaticamente
crash em todas as outras janelas (por exemplo send/mark da Outbox), AWS gerenciado,
partição de rede ou todos os tipos financeiros simultaneamente. Esses cenários
exigem ensaios próprios; nenhum limite desta prova é contornado com mocks/skips.

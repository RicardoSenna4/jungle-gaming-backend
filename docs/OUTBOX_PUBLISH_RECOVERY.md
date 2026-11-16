# Recuperação pós-publicação / pré-confirmação da Outbox

O target obrigatório outbox-publish-recovery usa PG, LocalStack e publishers em
processos independentes. Um subclass de teste pausa depois de SendMessage retornar
e antes de markPublished; o pai recebe o evento no SQS e verifica published_at NULL.
SIGKILL encerra o processo; após expiração real da lease, outro publisher retoma.
A tentativa SQL sobe para 2, published_at é confirmado e eventId permanece igual.
Wallet/ledger são comparados antes/depois. Banco/filas são exclusivos e descartados.
Fixture test-only é excluído da imagem; produção não possui toggle de pausa.

Garantia: **at-least-once**, nunca exactly-once fim a fim. Dentro da janela FIFO,
o reenvio pode ser suprimido pelo deduplication ID (eventId), mas depois da janela
pode haver nova entrega. Consumidores precisam deduplicação persistente por eventId.
A prova confirma recepção do primeiro envio e recuperação da confirmação, sem
inferir duas entregas dentro da janela FIFO. Evidência em
.test-results/outbox-publish-recovery-evidence.json, incluída no upload do CI.

Evidência real versionada da execução final local:
[evidence/task8/outbox-publish-recovery.json](evidence/task8/outbox-publish-recovery.json).
IDs/PIDs são sintéticos de teste; sinal SIGKILL, attempts=2 e snapshot preservado.
CI existente executa o target e publica seu artefato; resultado remoto precisa ser
consultado no SHA publicado, sem presumir que o sucesso local o substitui.

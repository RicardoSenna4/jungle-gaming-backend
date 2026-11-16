# OPEN ISSUES — Limitações e decisões de escopo

Este documento não substitui a matriz de requisitos nem o resultado do CI.
Uma limitação de entrega deve ser reclassificada como bloqueante se violar
requisito obrigatório ou falha eliminatória.

- **Autenticação:** OIDC/JWT foi implementado de forma opt-in. Com `AUTH_MODE=oidc`,
  o guard exige Bearer JWT RS256, valida assinatura por JWKS, issuer, audience,
  expiração/ativação e vincula a claim de identidade ao `providerId` do request.
  O modo `challenge` permanece permissivo para compatibilidade com o enunciado;
  não expor a API pública nesse modo. Ainda ficam fora do escopo local a operação
  de um IdP real e rotação/monitoramento de segredos. **Bloqueio de produção:**
  o provisionamento confiável de identidades e grants precisa preceder exposição.
  As exposições A1–A7 são tratadas em HTTP por vínculos persistentes e capabilities;
  ver [ADR-019](adr/019-provider-resource-authorization.md). Não há backfill automático
  ou propriedade exclusiva. Conta administrativa PostgreSQL do Compose, IdP real,
  ingresso externo autenticado de SQS e UI administrativa não são configuração de produção.
- **Exactly-once:** não prometido entre PostgreSQL/SQS. Eventos carregam `eventId`;
  consumidores downstream reais precisam implementar deduplicação persistente.
- **Operação AWS:** Compose usa LocalStack; real AWS, TLS, credenciais gerenciadas,
  observabilidade centralizada e deployment HA são fora do escopo local.
- **FAILED:** formalizado como terminal operacional/permanente, sem alteração de
  wallet ou ledger. Mensagens inválidas são persistidas em `message_quarantine`
  antes do ACK, com consulta e resolução autenticadas; falhas transitórias
  continuam sem ACK e seguem retry/DLQ. Grants separados de leitura/resolução
  estão implementados; escopos por fila/consumer e redrive automatizado por operador
  dependem do contrato de infraestrutura específico.
  Mensagens permanentemente inválidas são confirmadas após persistência na
  quarentena; **não** devem aparecer na DLQ. Falhas de processamento transitórias
  continuam sem ACK e podem seguir para a DLQ por redrive.
- **WIN com referência opcional:** o processamento não depende da referência
  opcional de WIN para crédito; REFUND/ROLLBACK possuem dependência obrigatória.
  Se o provedor exigir validação de WIN referenciada, o contrato deve ser
  enriquecido e testado explicitamente.
- **Testes de carga:** diferencial opcional; não declarar RPS ou percentis
  p95/p99 sem ensaio válido. Concorrência funcional obrigatória não é benchmark.
- **Checklist humano:** clonar em máquina do proprietário, conferir permissões
  da banca considerando a visibilidade pública atual, revisar os commits e enviar a submissão no canal oficial.
  Esses itens não podem ser concluídos automaticamente pelo agente.

Registrar aqui quaisquer falhas reais remanescentes após a execução do CI
do SHA final e transferir ao checklist de entrega se forem bloqueantes.

Papéis/permissões JWT configuráveis e grants operacionais são exigidos para
quarentena em OIDC. Métricas externas seguem a política em
[ADMINISTRATIVE_ACCESS](ADMINISTRATIVE_ACCESS.md); challenge dev/test conserva
compatibilidade local, enquanto challenge production desabilita métricas por padrão.
Delegação de quarentena é global explícita; isolamento operacional por tenant/fila
exigiria origem confiável persistida, sem inferir provider pelo raw payload.

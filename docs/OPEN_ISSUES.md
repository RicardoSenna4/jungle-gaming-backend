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
  autenticação OIDC não garante isolamento por recurso. UUIDs, ledger/reconciliação,
  criação de wallets e quarentena têm exposições reproduzidas; o GET por provider
  também admite bypass por precedência do body. Ver [ADR-019](adr/019-provider-resource-authorization.md)
  para evidências, matriz, dados legados e plano reversível. O enforcement permanece
  pendente, sem inferir propriedade exclusiva de wallets.
- **Exactly-once:** não prometido entre PostgreSQL/SQS. Eventos carregam `eventId`;
  consumidores downstream reais precisam implementar deduplicação persistente.
- **Operação AWS:** Compose usa LocalStack; real AWS, TLS, credenciais gerenciadas,
  observabilidade centralizada e deployment HA são fora do escopo local.
- **FAILED:** formalizado como terminal operacional/permanente, sem alteração de
  wallet ou ledger. Mensagens inválidas são persistidas em `message_quarantine`
  antes do ACK, com consulta e resolução autenticadas; falhas transitórias
  continuam sem ACK e seguem retry/DLQ. RBAC fino e redrive automatizado por
  operador continuam dependentes do contrato de infraestrutura específico.
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

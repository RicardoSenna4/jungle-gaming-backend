# OPEN ISSUES — Limitações e decisões de escopo

Este documento não substitui a matriz de requisitos nem o resultado do CI.
Uma limitação de entrega deve ser reclassificada como bloqueante se violar
requisito obrigatório ou falha eliminatória.

- **Autenticação:** OIDC/JWT foi implementado de forma opt-in. Com `AUTH_MODE=oidc`,
  o guard exige Bearer JWT RS256, valida assinatura por JWKS, issuer, audience,
  expiração/ativação e vincula a claim de identidade ao `providerId` do request.
  O modo `challenge` permanece permissivo para compatibilidade com o enunciado;
  não expor a API pública nesse modo. Ainda ficam fora do escopo local a operação
  de um IdP real, rotação/monitoramento de segredos e políticas avançadas de RBAC.
- **Exactly-once:** não prometido entre PostgreSQL/SQS. Eventos carregam `eventId`;
  consumidores downstream reais precisam implementar deduplicação persistente.
- **Operação AWS:** Compose usa LocalStack; real AWS, TLS, credenciais gerenciadas,
  observabilidade centralizada e deployment HA são fora do escopo local.
- **FAILED:** definido como terminal auditável; falhas antes de commit não podem
  produzir registro confirmado. DLQ e outbox oferecem auditabilidade operacional;
  política de falha permanente deverá ser ampliada em produção conforme contrato
  de infraestrutura específico.
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

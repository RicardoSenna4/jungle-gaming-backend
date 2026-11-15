# Orientações para agentes de desenvolvimento

## Fonte de verdade

1. [CHALLENGE_SPEC.md](CHALLENGE_SPEC.md) preserva o enunciado. Quando houver divergência com documentos de apoio, prevalece a [especificação oficial](https://github.com/junglegaming/backend-challenge).
2. [ARCHITECTURE.md](ARCHITECTURE.md) explica os limites das camadas e as decisões aplicadas.
3. [REQUIREMENTS_TRACEABILITY.md](docs/REQUIREMENTS_TRACEABILITY.md) mapeia requisitos, implementação e testes; [TESTING.md](docs/TESTING.md) explica reprodução.
4. Documentação pública para avaliadores fica no README e em docs/API.md, docs/DEMO.md, docs/TESTING.md. Registros de execução e planejamento permanecem em docs/14_PROGRESS.md e nos demais arquivos históricos.

## Invariantes

- Dinheiro como string decimal de duas casas nos contratos e `Money` no domínio; não usar `number` para montantes.
- Wallet por jogador/moeda, saldo nunca negativo, versão e ledger imutável e auditável.
- Operações de saldo, transação financeira, Inbox e Outbox devem respeitar atomicidade SQL.
- Concorrência serializada pela **wallet**, não por mutex global ou estado em memória.
- Idempotência por identidade persistida e payload canônico; replays preservam a resposta original.
- SQS é at-least-once. ACK somente após commit; Outbox publica somente após commit.
- Reversões devem validar tipo, valor integral e referência/contexto; não criar créditos duplicados.
- Nunca diminuir cobertura de testes, substituir integração por mocks ou forçar CI verde com skips.

## Procedimento de mudança

1. Investigar antes de alterar; escrever um teste que demonstra um defeito reproduzido quando possível.
2. Manter alterações pequenas, com commit real e identificável. **Não** reescrever histórico nem excluir evidências de CI sem autorização.
3. Para mudanças financeiras, executar `bun run test:all` em banco e filas isolados e validar PostgreSQL/SQS reais.
4. Executar `bun run typecheck`, `bun run lint`, `bun run format:check`, `bun run build`.
5. Ao adicionar testes, registrar o spec em `scripts/test-suite-runner.ts` para evitar skips ocultos.
6. Atualizar rastreabilidade, documentação e limitações quando o comportamento mudar.
7. Só integrar na main após CI verde no SHA relevante; não prometer que testes comprovam falhas ainda não ensaiadas.

## Operações destrutivas

A suíte de integração pode truncar tabelas. `scripts/smoke-compose.ts` encerra/reinicia o container API e consome mensagens locais da fila de eventos. Não execute contra produção, ambientes compartilhados ou dados reais. Use `SMOKE_ALLOW_DISRUPTION=1` apenas em Compose isolado.

## Escopo de entrega

O guard de autenticação é propositalmente permissivo por decisão de desafio; não representa segurança de produção. Repositório público é uma configuração de compartilhamento que depende do proprietário. A aprovação dos avaliadores e a submissão oficial não podem ser presumidas.

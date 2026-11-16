# Carga financeira em ambiente descartável

Suíte independente de test:all, sem credenciais ou alvos de produção. Requer Docker
Compose, Python3, Bun1.1.38 e dependências instaladas. Na raiz:

```bash
bun install --frozen-lockfile
bun run build
python3 performance/run.py
```

O runner cria um projeto Compose com nome aleatório, PostgreSQL16 e LocalStack3.8
próprios, sem portas de host, dados ou volumes compartilhados. Executa migrations,
aguarda readiness e roda k6 0.54.0 com 4 VUs e 20 iterações por cenário. Remove os
containers e volumes próprios em finally. Resultados e logs ficam em results/
(ignorados pelo Git). Não altere BASE_URL para uma implantação existente. O script
k6 recusa alvo diferente de http://api:3000 e exige LOAD_DISPOSABLE=yes.

- parallel: quatro wallets independentes, BETs em paralelo.
- hot: quatro VUs competem pela mesma wallet.
- limited: vinte wallets com100.00; dois BETs80.00 em batch por wallet, exigindo
  exatamente um200 e um422 por par, saldo final20.00.
- replays: vinte reenvios do mesmo comando; um único efeito e flag de replay.
- mixed: BET2, WIN1, LOSS1, REFUND2, ROLLBACK1; saldo líquido invariável.

Após k6, verify.ts publica20 comandos SQS reais e aguarda processamento Inbox e
Outbox. Valida todos os totais esperados, saldo não negativo, soma SQL do ledger,
reconciliação HTTP de cada wallet, contagem Inbox e presença de eventos no broker.
Não confunde redelivery com exactly-once: transporte continua at-least-once.
ACK/process crash são cobertos nos testes funcionais obrigatórios independentes.

Falhas inesperadas devem ser zero e checks100%;422 esperado na disputa de saldo
não entra como erro técnico. Throughput e percentis incluem setup/teardown HTTP
(wallets e reconciliação), não somente BET. Latência financeira do servidor fica
no histograma api-metrics.txt, separado do round-trip HTTP k6. O tempo assíncrono
mede o lote até todos os commits/publicações observados, com polling100ms; não é
p99 individual. Não há limite arbitrário de latência usado para esconder falhas.

Amostra Dockerstats é pontual, após o cenário HTTP. Neste ambiente gerenciado os
contadores de cgroup podem agregar processos/IO; não atribua a amostra a um pico
isolado da aplicação. Nenhum perfil de CPU ou consumo máximo foi medido.

Workflow performance.yml permite execução manual isolada em runner GitHub, sem
entrar na suíte funcional obrigatória. Não foi verificada execução remota nesta
sessão. Para ampliar o ensaio, revise juntos VUs/iterações, número de wallets,
saldos esperados e timeout de drenagem em financial.js/verify.ts; nunca reutilize
banco real. O relatório versionado descreve precisamente a execução feita.

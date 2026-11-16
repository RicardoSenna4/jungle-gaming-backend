# Evidência de desempenho — 2026-11-16

Execução real em Compose descartável removido ao final; Bun1.1.38, PostgreSQL16,
LocalStack3.8, k6 0.54.0, Docker29.9.2. Uma API; workers Inbox/Outbox no mesmo
processo; challenge, sem custo RS256/JWKS. Quatro VUs e vinte iterações por cenário.
Host gerenciado Linux6.18.57, AMD EPYC9V74, cinco CPUs lógicas visíveis ao Docker,
35.743.748.096 bytes de RAM reportados pelo daemon. Sem reserva/exclusividade de
hardware ou limite de CPU/memória de container; outros serviços locais ociosos
existiam. Não é comparação controlada nem prova de capacidade de produção.

| Cenário | Requisições HTTP | req/s observado | p50 ms | p95 ms | p99 ms | Erro inesperado |
|---|---:|---:|---:|---:|---:|---:|
| parallel | 28 | 40.36 | 82.41 | 133.88 | 136.57 | 0% |
| hot | 22 | 35.17 | 94.64 | 224.26 | 265.38 | 0% |
| limited | 80 | 87.31 | 39.45 | 107.77 | 125.06 | 0% |
| replays | 23 | 146.62 | 16.09 | 29.02 | 30.37 | 0% |
| mixed | 108 | 91.15 | 40.41 | 74.26 | 88.49 | 0% |

Os valores vêm dos summaries brutos em [evidence/task11](evidence/task11/),
incluem setup/teardown e correspondem a ensaios de aproximadamente0.1–1.5s.
Todos os checks passaram. As vinte rejeições422 de limited são esperadas.
Não extrapolar esses rates para tráfego sustentado ou OIDC em produção.

Invariantes:31 wallets,232 transações (incluindo aberturas/rejeições/LOSS),192
entradas de ledger,20 Inbox com processed_at,424 Outbox publicados e424 mensagens
de evento observadas no SQS. Todas as wallets reconciliadas; saldos agregados:
parallel3980.00, hot980.00, limited400.00, replays999.00, mixed4000.00, async980.00.
Lote assíncrono de20 comandos até commits/publicação:8770.55ms, incluindo drenagem
de Outbox anterior e polling; não representa latência individual de cada mensagem.

Amostra Dockerstats reportou152.26% CPU e5.41GiB/32GiB,405PIDs; coleta única depois
da carga HTTP, sujeita à agregação de cgroup do ambiente gerenciado. Não é pico,
nem foi comprovado que toda essa memória pertencia à API. O arquivo bruto permite
reavaliar essa limitação. Métricas de duração de processamento do servidor também
foram salvas em api-metrics.txt; não inventamos p99 a partir de buckets largos.

## Recomendações a validar

Repetir com ramp-up e períodos de vários minutos, warmup e OIDC real em ambiente
reservado antes de definir SLO. Comparar contenção com wallets independentes;
investigar tempo de lock/retries e pool PostgreSQL. Medir por mensagem a fila e o
lag Outbox, calibrar batch/intervalo e visibility com p99 real. Medir CPU/memória
com cgroups isolados e múltiplas réplicas antes de dimensionar Fargate. Preservar
reconciliação e testes de saldo em todas as variações; nenhuma regra financeira
foi alterada para aumentar throughput.

Typecheck, lint, format e build passaram; test:all:136 testes/23targets sem
falhas/skips. O relatório não afirma execução remota de CI nem carga de produção.

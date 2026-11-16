# Observabilidade opcional

O Compose padrão permanece sem coletores. Para o ambiente local challenge:

```bash
ENABLE_DB_METRICS_SAMPLER=true docker compose --profile observability up -d
```

Prometheus: http://localhost:9090; Grafana: http://localhost:3001, usuário admin.
A senha padrão `local-development-only` serve exclusivamente à demonstração local;
defina GRAFANA_ADMIN_PASSWORD antes de expor qualquer ambiente. As portas dos
coletores escutam somente em loopback. Não publique /metrics na Internet.
Dashboard `jungle-operations` e datasource são provisionados automaticamente.
Dados dos coletores são efêmeros; configure armazenamento e retenção para operação.

## Coleta e segurança

ENABLE_DB_METRICS_SAMPLER=true habilita amostragem SQL a cada 10s, uma coleta por
vez, com EntityManager separado. /metrics continua servindo valores em memória.
Falha de coleta preserva a última amostra e publica success=0. Quarentena tem
apenas quatro labels de status; nenhum ID de wallet, jogador ou transação vira label.
DLQ é amostrada pelo consumer existente: habilite-o e configure a URL da DLQ.
Reconciliação reflete verificações executadas, não um scanner automático de wallets.
Métricas locais de cada processo devem ser coletadas por instância em implantação
horizontal; não some gauges globais do banco entre réplicas sem deduplicar.

Em OIDC o guard continua exigindo identidade operacional e metrics:read. Prepare
um cliente do IdP conforme [OIDC_ROLLOUT.md](OIDC_ROLLOUT.md), gere a configuração
autenticada com scripts/oidc-rollout.ts e monte o secret fora do Git:

```bash
PROMETHEUS_OIDC_CONFIG_FILE=/secure/prometheus.json \
PROMETHEUS_CLIENT_SECRET_FILE=/secure/client-secret \
docker compose -f docker-compose.yml -f infra/observability/compose.oidc.yml \
  --profile observability up -d prometheus grafana
```

O arquivo gerado deve incluir as regras em /etc/prometheus/alerts.yml e o target
interno correto; proteja a leitura do secret para o UID do Prometheus. Audience e
roles dependem do IdP real. Não há relaxamento de autenticação para o coletor.

## Alertas e limiares iniciais

| Condição | Limiar | Persistência |
|---|---|---|
| Target indisponível | up=0 | 2 min |
| DLQ | >0 mensagens | 2 min |
| Quarentena aberta | >0 mensagens | 5 min |
| Outbox parada | evento mais antigo >120s | 2 min |
| Divergência financeira | incremento em 5 min | imediato |
| Amostrador SQL falhou | success=0 | 2 min |

São limiares iniciais para ensaio; calibre com SLO e tráfego reais. Regras são
avaliadas no Prometheus. Alertmanager e entrega externa não foram configurados
nem comprovados. Ausência de série não equivale a zero: verifique target,
workers e configuração do amostrador ao investigar painéis vazios.

## Evidência local em 2026-11-16

Promtool v3.2.1 validou configuração e seis regras. Prometheus /-/ready e Grafana
/api/health responderam HTTP 200; /api/search retornou jungle-operations. Uma API
Bun 1.1.38 no Docker, com PostgreSQL16 e banco descartável próprio, foi coletada:
/api/v1/query?query=up retornou job=jungle-api, instance=api:3000, value=1.
Não houve entrega externa de alertas. Teste PostgreSQL verifica séries de
quarentena/Outbox e preservação de saldo/versão. Suíte completa: 136 testes em
23 targets, sem falhas ou skips; typecheck, lint, format e build aprovados.

# Galeria: execução real e evidências

As imagens usam dados sintéticos de um Compose descartável, em modo `challenge`,
sem conexão com produção. O código da aplicação exercitado é o SHA registrado em
[evidence.json](evidence.json). Não há alterações nas regras financeiras.

| Arquivo | Natureza | O que demonstra |
|---|---|---|
| grafana-live.png | Captura direta do Grafana 11.6.0 | Primeiros oito painéis provisionados consultando amostras reais do Prometheus |
| prometheus-target.png | Captura direta do Prometheus 3.2.1 | Target `jungle-api`, endpoint `api:3000`, coleta saudável |
| financial-flow.png | Relatório visual HTTP/SQL | Abertura 100.00, BET 25.00, cinco replays, saldo 75.00 e reconciliação |
| persistent-deduplication.png | Relatório visual SQS/PostgreSQL | Duas mensagens distintas com um mesmo eventId e um efeito persistido |
| ci-success.png | Relatório de metadados públicos | Execução CI aprovada no SHA da demonstração, com link verificável |

Os relatórios HTML são produzidos pelos scripts a partir dos resultados reais;
não são um frontend da aplicação nem uma interface administrativa existente.
O resumo de CI também não imita a UI do GitHub. O site público foi consultado e
confirmou sucesso, mas o host dos seus estilos foi bloqueado pela rede deste
ambiente; por isso usamos um relatório identificado, com [metadados](ci.json).
Nenhum token, senha de operador ou dado de cliente foi colocado nas imagens.

## Fontes e limites

- [evidence.json](evidence.json): respostas HTTP, contagens SQL, IDs sintéticos,
  reconciliação e deduplicação do consumidor de referência.
- [traffic.json](traffic.json): operações processadas, rejeições esperadas, um
  conflito de payload esperado e reconciliação das wallets usadas para tráfego.
- [prometheus-up.json](prometheus-up.json): resultado da consulta real `up`.
- [ci.json](ci.json): SHA, execução, branch no momento do run e conclusão pública.
- [manifest.json](manifest.json): hashes das imagens e fontes para conferência.

O coletor aguarda 120 segundos de tráfego antes das capturas, depois mantém o
tráfego durante a renderização. O total varia com a máquina. Não é um benchmark,
teste de disponibilidade prolongada ou prova de capacidade de produção. Painéis
de DLQ e quarentena podem legitimamente mostrar zero. O painel de divergências,
fora do enquadramento da captura, pode mostrar `No data` quando o contador não
foi emitido; ausência de série não prova zero. A reconciliação desta execução
é comprovada separadamente pelas respostas HTTP/SQL. Os gráficos
usam a janela recente de cinco minutos do ambiente de demonstração.

A BET HTTP demonstra idempotência da aplicação. A outra demonstração recebe um
evento realmente publicado pela Outbox, envia duas cópias com deduplication IDs
SQS diferentes e processa as duas mensagens em concorrência com duas conexões
PostgreSQL. Isso evita que a deduplicação FIFO do broker esconda o segundo
recebimento. A projeção `reference_events` é didática e isolada: não atualiza a
wallet nem o ledger. ACK acontece depois do commit. A verificação de visibilidade
vazia é imediata; a garantia de transporte permanece **at-least-once**. As provas
de crash/redelivery continuam nos testes de integração obrigatórios do projeto.

O CI mostrado é um snapshot histórico do SHA indicado. Para avaliar mudanças
posteriores, consulte os runs da `main`; uma imagem não é um badge dinâmico.

## Reproduzir em Linux/WSL

Requisitos: Docker Compose v2, Bun 1.1.38, Python 3 com pacote `playwright` e
Chromium em `/usr/bin/chromium`. As portas 3130, 3131 e 9190 devem estar livres.
Os scripts sobrescrevem somente os arquivos da galeria: use uma branch de trabalho.

```bash
bun install --frozen-lockfile
bun run build
python3 -m pip install playwright

# Arquivos públicos de provisioning precisam ser legíveis pelo UID do Grafana.
chmod -R a+rX infra/observability
export GALLERY_SOURCE_COMMIT="$(git rev-parse HEAD)"
docker compose -p jungle-gallery-demo \
  -f performance/compose.yml -f docs/gallery/compose.yml \
  up -d api prometheus grafana

python3 scripts/capture-gallery.py
python3 scripts/capture-gallery-ci.py
```

Para refazer somente o enquadramento das interfaces no mesmo ambiente ainda ativo,
use `python3 scripts/capture-gallery.py --ui-only` enquanto as amostras recentes
estiverem no Prometheus. Essa opção reutiliza as evidências HTTP/SQL e o relatório
de tráfego já gravados, sem repetir as operações financeiras. Reexecute depois
`capture-gallery-ci.py` para atualizar os hashes do manifest.

O primeiro script exige o container do projeto dedicado e banco de testes; não
aceita URL externa. Usa PostgreSQL16/LocalStack3.8 novos, sem portas do banco/SQS
expostas ao host. Grafana/Prometheus/API são publicados apenas em loopback. A
senha do Grafana é um valor público de demonstração local, não configuração para
exposição externa. `NO_PROXY` evita enviar chamadas internas ao proxy do host.
No modo OIDC, preserve os guards e a configuração de coletor autenticado descrita
em [OBSERVABILITY.md](../OBSERVABILITY.md); esta galeria não prova um rollout IdP.

O segundo script exige um run público aprovado para o mesmo SHA da evidência.
Se ainda não houver, ele falha em vez de fabricar sucesso. Usa a confiança TLS
do cliente Python configurado; não desativa verificação de certificados. Não há
necessidade de autenticar no GitHub para ler estes metadados públicos.

Depois de inspecionar as imagens e salvar as evidências, encerre **somente este
projeto descartável**, removendo seus volumes de demonstração:

```bash
docker compose -p jungle-gallery-demo \
  -f performance/compose.yml -f docs/gallery/compose.yml \
  down -v --remove-orphans
```

O comando não é uma instrução para apagar volumes do ambiente padrão do projeto.
Não execute os scripts de demonstração contra serviços compartilhados ou produção.

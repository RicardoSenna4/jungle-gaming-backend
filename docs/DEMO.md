# Guia de execução e validação passo a passo

Este é um guia de primeiros passos para **qualquer pessoa que queira baixar o projeto e vê-lo funcionando localmente**, sem conhecer a arquitetura nem preparar banco de dados manualmente.

**O que você verá:** o projeto é um **back-end**, sem interface gráfica. Você pode abrir os endpoints de saúde no navegador e interagir com a API pelo terminal. As operações retornam **JSON** com carteira, saldo, transações e histórico financeiro.

## 1. O que instalar

- [Git](https://git-scm.com/downloads), para baixar o repositório.
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) no Windows/macOS, ou Docker Engine com Compose Plugin no Linux.
- Um terminal: **PowerShell** (Windows) ou **Bash** (Linux, macOS, WSL/Ubuntu ou Git Bash).
- Se optar por Bash, o comando **`curl`** precisa estar disponível. Os exemplos deste guia **não exigem `jq`**.

Não é necessário instalar **Bun, Node.js, PostgreSQL ou LocalStack** para rodar a aplicação pelo Docker.

Confirme que o Docker Desktop/Engine está iniciado e que as portas **3000**, **5432** e **4566** estão disponíveis.

Confira as instalações no terminal escolhido:

~~~bash
git --version
docker --version
docker compose version
~~~

### Qual terminal escolher no Windows?

| Opção | O que instalar ou habilitar | Qual seção seguir |
|---|---|---|
| **PowerShell (mais simples)** | Git for Windows + Docker Desktop, com o Docker Engine iniciado. **Não precisa de WSL como terminal nem de `jq`** | **Opção A** da etapa 4 |
| **WSL/Ubuntu** | WSL 2 com uma distribuição Linux; Docker Desktop usando o backend WSL 2 e integração habilitada para essa distribuição; Git e `curl` dentro do Linux | **Opção B** da etapa 4 |
| **Git Bash** | Git for Windows (inclui Git Bash) e Docker Desktop; `docker` e `curl` devem estar disponíveis no PATH do Git Bash | **Opção B** da etapa 4 |

**Usando WSL no Windows 11 (opcional):**

1. No **PowerShell como administrador**, se ainda não tiver WSL, execute `wsl --install -d Ubuntu` e siga a instalação/reinicialização solicitada pelo Windows. Caso já tenha WSL, verifique com `wsl --list --verbose` se a distribuição está em WSL 2.
2. Abra o **Docker Desktop → Settings → General** e confirme o uso do **WSL 2 based engine**. Depois acesse **Settings → Resources → WSL Integration** e habilite a distribuição Ubuntu, se essa tela estiver disponível na sua versão do Docker Desktop.
3. Abra o terminal **Ubuntu (WSL)**. Instale Git e `curl`, se necessário: `sudo apt update && sudo apt install -y git curl`.
4. Ainda no Ubuntu, confirme `git --version`, `curl --version` e `docker compose version`. Faça o clone preferencialmente no diretório pessoal do Linux (`~/`), não em `/mnt/c`.

**Usando Git Bash:** abra o aplicativo **Git Bash** instalado com Git for Windows, confirme `git --version`, `curl --version` e `docker compose version` e siga os blocos marcados como Bash. Para este roteiro não é necessário `jq`. Se o comando `docker` não existir no Git Bash, reinicie o terminal depois de instalar/iniciar o Docker Desktop e confira o PATH.

**Não misture sintaxes:** os comandos da **Opção A** usam `$walletId` e `Invoke-RestMethod` (PowerShell); os da **Opção B** usam `$WALLET_ID` e `curl` (Bash). Execute cada sequência no terminal indicado.

## 2. Baixar e iniciar a aplicação

No Windows, use a janela do **PowerShell**, do **Ubuntu/WSL** ou do **Git Bash** que você selecionou acima. Para WSL, execute o clone dentro do filesystem do Linux. Não é necessário copiar arquivos de configuração nem fornecer credenciais AWS.

Abra o terminal e execute:

~~~bash
git clone https://github.com/RicardoSenna4/jungle-gaming-backend.git
cd jungle-gaming-backend
docker compose up --build -d
~~~

Na primeira inicialização, o Docker fará download das imagens, compilará o back-end, iniciará PostgreSQL e LocalStack (SQS) e aplicará automaticamente as migrations. Isso pode levar algum tempo.

Veja o estado dos containers:

~~~bash
docker compose ps
~~~

Os três serviços devem aparecer: `api`, `postgres` e `localstack`. Para conferir o log da API:

~~~bash
docker compose logs --tail=80 api
~~~

## 3. Verificar o sistema no navegador

Abra estes links:

1. [http://localhost:3000/health/live](http://localhost:3000/health/live) — funcionamento do processo.
2. [http://localhost:3000/health/ready](http://localhost:3000/health/ready) — conectividade com banco e SQS.

O primeiro deverá exibir:

~~~json
{"status":"ok"}
~~~

O segundo, quando tudo estiver pronto:

~~~json
{"status":"ok","checks":{"postgres":"up","sqs":"up"}}
~~~

Se o segundo retornar **503**, o sistema ainda não está pronto: confira `docker compose ps` e os logs dos serviços.

## 4. Criar uma carteira e executar operações

Você vai: criar uma carteira com **100.00 BRL**, apostar **25.00 BRL**, repetir a mesma requisição para comprovar a idempotência, estornar a aposta e consultar saldo/ledger.

Escolha **um** dos caminhos abaixo conforme seu terminal. **Execute os comandos na mesma sessão**, pois cada passo reutiliza variáveis do anterior.

### Opção A — Windows (PowerShell)

#### A.1. Criar carteira

Copie e execute o bloco completo:

~~~powershell
$base = "http://localhost:3000"
$playerId = "demo-" + [guid]::NewGuid().ToString("N")
$providerId = "provider-" + $playerId

$walletBody = @{
  playerId = $playerId
  initialBalance = @{ amount = "100.00"; currency = "BRL" }
} | ConvertTo-Json -Depth 5

$wallet = Invoke-RestMethod -Method Post -Uri "$base/wallets" -ContentType "application/json" -Body $walletBody
$walletId = $wallet.id
$wallet | ConvertTo-Json -Depth 5
~~~

**O que esperar:** um `id` gerado automaticamente, `balance.amount` igual a `"100.00"` e `version` igual a `1`.

#### A.2. Enviar uma aposta (BET)

~~~powershell
$betId = "bet-" + [guid]::NewGuid().ToString("N")
$betKey = "key-" + $betId

$betBody = @{
  providerId = $providerId
  externalTransactionId = $betId
  playerId = $playerId
  walletId = $walletId
  roundId = "round-demo"
  gameId = "game-demo"
  kind = "BET"
  money = @{ amount = "25.00"; currency = "BRL" }
} | ConvertTo-Json -Depth 5

$betHeaders = @{ "Idempotency-Key" = $betKey }
Invoke-RestMethod -Method Post -Uri "$base/wagering/transactions" -ContentType "application/json" -Headers $betHeaders -Body $betBody | ConvertTo-Json -Depth 5
~~~

**O que esperar:** status `PROCESSED`, saldo `"75.00"` e `idempotentReplay: false`.

#### A.3. Repetir a aposta sem novo desconto

Execute **o mesmo comando**, reutilizando `$betBody` e `$betHeaders`:

~~~powershell
Invoke-RestMethod -Method Post -Uri "$base/wagering/transactions" -ContentType "application/json" -Headers $betHeaders -Body $betBody | ConvertTo-Json -Depth 5
~~~

**O que esperar:** `idempotentReplay: true`, mantendo o saldo original em `"75.00"`.

#### A.4. Estornar a aposta (REFUND)

~~~powershell
$refundId = "refund-" + [guid]::NewGuid().ToString("N")
$refundBody = @{
  providerId = $providerId
  externalTransactionId = $refundId
  playerId = $playerId
  walletId = $walletId
  roundId = "round-demo"
  gameId = "game-demo"
  kind = "REFUND"
  referenceExternalTransactionId = $betId
  money = @{ amount = "25.00"; currency = "BRL" }
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post -Uri "$base/wagering/transactions" -ContentType "application/json" -Headers @{ "Idempotency-Key" = "key-$refundId" } -Body $refundBody | ConvertTo-Json -Depth 5
~~~

**O que esperar:** `PROCESSED` e saldo restaurado para `"100.00"`.

#### A.5. Ver o saldo e o histórico

~~~powershell
Invoke-RestMethod "$base/wallets/$walletId" | ConvertTo-Json -Depth 5
Invoke-RestMethod "$base/wallets/$walletId/ledger?limit=20" | ConvertTo-Json -Depth 8
Invoke-RestMethod -Method Post "$base/wallets/$walletId/reconciliation" | ConvertTo-Json -Depth 5
~~~

**O que esperar:** saldo `100.00`; três registros no ledger (`OPENING`, `BET`, `REFUND`) e reconciliação `consistent: true`. O replay não cria lançamento extra.

### Opção B — Linux/macOS ou Bash (incluindo WSL/Git Bash)

Este caminho utiliza apenas `curl`, normalmente disponível no sistema. Para evitar exigir `jq`, você copiará o ID retornado na criação da carteira.

#### B.1. Criar carteira

~~~bash
BASE="http://localhost:3000"
PLAYER_ID="demo-$(date +%s)-$RANDOM"
PROVIDER_ID="provider-$PLAYER_ID"

curl -sS -X POST "$BASE/wallets" -H "Content-Type: application/json" \
  -d "{\"playerId\":\"$PLAYER_ID\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}"
~~~

Copie o campo `"id"` da resposta (um UUID) para a variável:

~~~bash
WALLET_ID="COLE_AQUI_O_UUID_RETORNADO"
~~~

O saldo inicial deverá ser `100.00`.

#### B.2. Enviar a aposta

~~~bash
BET_ID="bet-$PLAYER_ID"
BET_KEY="key-$BET_ID"
BET_BODY="{\"providerId\":\"$PROVIDER_ID\",\"externalTransactionId\":\"$BET_ID\",\"playerId\":\"$PLAYER_ID\",\"walletId\":\"$WALLET_ID\",\"roundId\":\"round-demo\",\"gameId\":\"game-demo\",\"kind\":\"BET\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"

curl -sS -X POST "$BASE/wagering/transactions" \
  -H "Content-Type: application/json" -H "Idempotency-Key: $BET_KEY" -d "$BET_BODY"
~~~

**O que esperar:** `PROCESSED` com saldo `75.00`.

#### B.3. Repetir a mesma aposta

~~~bash
curl -sS -X POST "$BASE/wagering/transactions" \
  -H "Content-Type: application/json" -H "Idempotency-Key: $BET_KEY" -d "$BET_BODY"
~~~

**O que esperar:** `idempotentReplay: true`, sem novo débito.

#### B.4. Estornar a aposta

~~~bash
REFUND_ID="refund-$PLAYER_ID"
REFUND_BODY="{\"providerId\":\"$PROVIDER_ID\",\"externalTransactionId\":\"$REFUND_ID\",\"playerId\":\"$PLAYER_ID\",\"walletId\":\"$WALLET_ID\",\"roundId\":\"round-demo\",\"gameId\":\"game-demo\",\"kind\":\"REFUND\",\"referenceExternalTransactionId\":\"$BET_ID\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"

curl -sS -X POST "$BASE/wagering/transactions" \
  -H "Content-Type: application/json" -H "Idempotency-Key: key-$REFUND_ID" -d "$REFUND_BODY"
~~~

**O que esperar:** `PROCESSED`, saldo `100.00`.

#### B.5. Ver o resultado

~~~bash
curl -sS "$BASE/wallets/$WALLET_ID"
curl -sS "$BASE/wallets/$WALLET_ID/ledger?limit=20"
curl -sS -X POST "$BASE/wallets/$WALLET_ID/reconciliation"
~~~

**O que esperar:** saldo `100.00`, três lançamentos no ledger e `consistent: true`.

## 5. Explorar outros recursos

Para interações mais avançadas, você pode usar **Postman, Insomnia ou Bruno**, mas são opcionais. Não existe interface Swagger nem um painel visual nesta aplicação.

| Recurso | Onde testar |
|---|---|
| Consultar transação pelo ID | `GET /wagering/transactions/:transactionId` |
| Consultar transação pelo provedor | `GET /providers/:providerId/wagering/transactions/:externalTransactionId` |
| WIN (crédito) e LOSS (sem mudança de saldo) | `POST /wagering/transactions` com novo ID e chave |
| ROLLBACK | `POST /wagering/transactions` com referência elegível e valor integral |
| Métricas da aplicação | [http://localhost:3000/metrics](http://localhost:3000/metrics) |
| Contrato SQS, Inbox e Outbox | [API](API.md) e [testes LocalStack](../test/integration/sqs-localstack.spec.ts) |

Detalhes dos tipos de transação e retornos estão em [API.md](API.md).

## 6. Solução de problemas

| Sintoma | O que fazer |
|---|---|
| Docker não encontrado | Instale/abra o Docker Desktop e reinicie o terminal |
| API indisponível em `localhost:3000` | Rode `docker compose ps` e `docker compose logs --tail=100 api` |
| Portas 3000, 5432 ou 4566 ocupadas | Encerre o programa que usa a porta e reinicie os serviços |
| `health/live` funciona, `health/ready` retorna 503 | Confira `docker compose logs postgres` e `docker compose logs localstack` |
| `WALLET_ALREADY_EXISTS` | Crie outro `playerId`; os exemplos geram um valor novo |
| `IDEMPOTENCY_PAYLOAD_CONFLICT` | Use uma chave nova para um payload diferente |
| Erro 422 por saldo insuficiente | Consulte o saldo de sua wallet antes de apostar |
| Resposta 202/`PENDING_REFERENCE` | A referência ainda não foi processada; consulte o status da transação posteriormente |
| Comando Bash não funciona no PowerShell | Utilize a **Opção A**; variáveis e aspas são diferentes |

Mais detalhes nos logs:

~~~bash
docker compose logs --tail=100 api
docker compose logs --tail=100 postgres
docker compose logs --tail=100 localstack
~~~

## 7. Parar e reiniciar

Para encerrar o ambiente:

~~~bash
docker compose down
~~~

Para iniciar novamente:

~~~bash
docker compose up -d
~~~

**Atenção aos dados:** este Compose é destinado a demonstração e desenvolvimento. A configuração atual do serviço PostgreSQL não possui volume nomeado próprio, portanto **não conte com a persistência da carteira depois de recriar os containers**. Não use `docker compose down -v` com dados importantes.

## 8. Conferência rápida antes de considerar a instalação funcionando

Verifique localmente, no terminal escolhido:

- [ ] `docker compose ps` lista `api`, `postgres` e `localstack` em execução.
- [ ] As duas rotas de saúde abrem no navegador, com `status: "ok"`.
- [ ] Criar a carteira devolve HTTP **201**, um UUID e saldo inicial `100.00`.
- [ ] A BET de `25.00` deixa o saldo em `75.00`.
- [ ] Repetir a mesma BET retorna `idempotentReplay: true` sem novo desconto.
- [ ] O REFUND restaura o saldo a `100.00`.
- [ ] O ledger apresenta três lançamentos, e a reconciliação retorna `consistent: true`.

**Estado da validação:** a automação já executou esse fluxo em container Linux no [CI histórico aprovado](CI_EVIDENCE.md). **Ainda não foi comprovado aqui um ensaio interativo na máquina Windows do usuário, em WSL ou no Git Bash**; esta lista permite que qualquer pessoa faça essa homologação manual e reporte dificuldades reais.

## 9. E quanto aos testes automatizados?

**Você não precisa executar os testes para usar a aplicação.** Os testes de concorrência, recuperação e SQS estão documentados em [TESTING.md](TESTING.md) e são executados no [GitHub Actions](https://github.com/RicardoSenna4/jungle-gaming-backend/actions/workflows/ci.yml).

As suítes de integração podem executar `TRUNCATE` e apagar dados de testes. Não as execute no mesmo banco onde quiser manter a carteira criada.

O smoke `scripts/smoke-compose.ts` **derruba e reinicia o container** e consome eventos da fila de teste. Não faz parte deste guia inicial e não deve ser executado em ambiente compartilhado.

---

Ao concluir a etapa 4, você terá iniciado a API, criado uma carteira, registrado e estornado uma aposta, confirmado a idempotência e consultado o ledger e a reconciliação — tudo localmente.

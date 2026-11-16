# Rollout OIDC: plano explícito e preparação revisável

Este repositório não contém IdP ou coletor externos configurados. Não presumir
issuer, subjects ou aprovação de grants a partir de exemplos ou atividade legada.
`infra/rollout/plan.example.json` é um modelo, não um plano de produção aprovado.
Os domínios `.invalid` e subjects `REPLACE_WITH_*` impedem aplicação acidental.

## Dados necessários do responsável pelo ambiente

- IdP e issuer/realm, audience/client da API e endpoint de token OAuth2.
- Subjects exatos dos operadores/admins aprovados e ações delegadas por identidade.
- Identidade do administrador que aprovou o plano e identificador da mudança.
- Endpoint da API, destino do PostgreSQL e tipo/local do coletor.
- Credenciais via configurações seguras/secret manager, nunca no plano ou Git.

## Configuração no IdP

No cliente da API, manter RS256/JWKS e emitir `iss`, `aud`, `sub`, `exp`, `nbf`
quando aplicável. Mapear papéis para `roles` e permissões para `scope` no primeiro
nível do JWT. Provider financeiro recebe `providerId` coerente com seu binding
persistido; operadores não precisam de provider fictício.

- Operador de consulta: `roles=[operator]`, scope `quarantine:read` e grant SQL read.
- Administrador delegado: `roles=[admin]`, scopes aprovados individualmente
  `quarantine:read`/`quarantine:resolve`, e grants SQL das mesmas ações.
- Coletor: cliente confidencial exclusivo, client credentials, papel operacional,
  scope `metrics:read`, audience da API. Não conceder scopes/grants de quarentena,
  providers, wallets ou crédito inicial ao coletor.

A forma de criar mappers, service account e roles depende do IdP e deve ser aplicada
na instância indicada pelo usuário com acesso administrativo autorizado. Nenhum
IdP é criado/configurado automaticamente pelo script local.

## Preparar configurações sem alterar privilégios

Copie o exemplo para diretório de operação protegido, fora do checkout, e preencha
os identificadores aprovados. Execute:

```bash
bun run scripts/oidc-rollout.ts /secure/change/plan.json /secure/change/review
```

O padrão **não conecta ao banco nem altera grants**. Gera com criação exclusiva
(sem sobrescrever arquivos existentes) e permissões 0600:

- `api-environment.json`: variáveis não secretas para o runtime da API.
- `prometheus.json`: configuração candidata de Prometheus, JSON válido como YAML,
  com OAuth2 client credentials, scope `metrics:read` e `client_secret_file`.

O resumo imprime apenas status, hash SHA-256 e quantidade de subjects. Os arquivos
não contêm credenciais nem tokens. Se o coletor indicado não for Prometheus,
adaptar a integração OAuth2 àquele coletor, preservando audience/roles/scope.
Monte o secret no caminho configurado somente no coletor e restrinja sua rede de
acesso à API/IdP. A emissão correta de audience/roles é configuração do IdP.

## Aplicar somente grants explicitamente aprovados

Em processo administrativo autenticado, com credenciais de banco separadas,
confira o hash/subjects/ações do plano. DB_HOST, DB_PORT e DB_NAME devem coincidir
exatamente com seu alvo declarado. Depois execute com outro diretório de saída:

```bash
bun run scripts/oidc-rollout.ts /secure/change/plan.json /secure/change/applied --apply
```

A operação é atômica e idempotente, auditada por issuer/subject/origem administrativa.
Não cria grants de wallet/player, não infere providers, não revoga grants existentes
nem altera dados financeiros. O campo actor é atribuição de auditoria fornecida
pelo processo administrativo confiável, não uma autenticação criada pelo script.
No perfil production a conexão deste script exige TLS com verificação de certificado;
`DB_SSL_CA_FILE` opcional fornece CA confiável. Não desativar verificação para contornar
falhas. A configuração TLS da API e do banco no deploy também precisa ser verificada
antes de liberar tráfego; o script não faz deploy nem reconfigura a conexão da API.

Após configurar o IdP, aplicar os grants e atualizar o runtime, validar JWTs reais
emitidos pelo IdP: provider negado em quarentena; operador read permitido e resolve
negado; administrador aprovado permitido; metrics sem token 401, provider sem papel
403 e coletor delegado 200. Conferir scrape e renovação automática do token no
coletor. Tokens somente em Authorization, nunca em URL, plano, logs ou evidências.

A preparação/testes locais não comprovam configuração ou implantação do destino.

# Acesso administrativo e métricas

Em `AUTH_MODE=oidc`, um JWT válido sozinho não concede acesso administrativo.
O IdP deve emitir os papéis e permissões abaixo em claims assinadas; a aplicação
continua validando RS256, JWKS, issuer, audience, exp/nbf e subject. Headers de papel,
query/body e notas nunca são fontes de privilégios. Não há wildcard ou bypass de admin.

| Identidade | Quarentena | Recursos financeiros | Métricas em OIDC |
|---|---|---|---|
| Provider comum | Negado, mesmo com JWT válido e grants de wallet | Somente seus vínculos/capabilities persistentes | Negado sem papel operacional e permissão específica |
| Operador | Papel configurado **e** permissão JWT da ação **e** grant persistido issuer/sub da ação | Não herda grants financeiros | Papel configurado + permissão JWT `metrics:read` |
| Administrador | Papel configurado **e** permissão JWT da ação **e** grant persistido issuer/sub da ação | Não herda grants financeiros | Papel configurado + permissão JWT `metrics:read` |

O administrador é uma identidade administrativa distinta e pode ser provisionado
com as duas ações; o papel não elimina nenhuma condição. Operador read não recebe
resolve. Admin sem scope ou sem grant no banco é negado. `quarantine.read` e
`quarantine.resolve` no PostgreSQL continuam separados e revogáveis, com os locks
e a auditoria da ADR-019. Uma revogação de grant vale para a próxima requisição,
mesmo com token ainda válido; revogação de claims no IdP segue a validade do token.

A quarentena atual é um canal operacional **global compartilhado**, como definido
na ADR-019. Seu raw payload pode ser inválido ou ter provider forjado: nunca é usado
para atribuir tenant ou conceder privilégios. Uma delegação global permite atuar
nos registros de vários providers conscientemente. Providers comuns e identidades
com papel/permission mas sem delegação persistida não podem modificar registros
de outro provider. Se forem necessários operadores restritos por tenant/fila,
será preciso persistir origem confiável e definir outra política/projeção; não
simular esse isolamento filtrando JSON não confiável.

## Configuração de claims

| Variável | Padrão | Significado |
|---|---|---|
| `OIDC_ROLES_CLAIM` | `roles` | Nome exato da claim de papéis, no primeiro nível do JWT |
| `OIDC_PERMISSIONS_CLAIM` | `scope` | Nome exato da claim de permissões, no primeiro nível |
| `OIDC_OPERATOR_ROLES` | `operator` | Papéis de operador aceitos, separados por vírgula |
| `OIDC_ADMIN_ROLES` | `admin` | Papéis de administrador aceitos, separados por vírgula |
| `OIDC_QUARANTINE_READ_PERMISSION` | `quarantine:read` | Permissão JWT para consultar |
| `OIDC_QUARANTINE_RESOLVE_PERMISSION` | `quarantine:resolve` | Permissão JWT para resolver |
| `OIDC_METRICS_READ_PERMISSION` | `metrics:read` | Permissão JWT para ler métricas |

Claims aceitam array de strings ou string separada por espaços. A comparação é
exata e case-sensitive: `quarantine:read-extra` não concede `quarantine:read`.
Arrays malformados, claim ausente ou papel insuficiente resultam em 403. Configuração
vazia, wildcard ou inválida resulta em 503, sem fallback para defaults. Claims
aninhadas devem ser mapeadas pelo IdP para a claim de primeiro nível configurada;
a aplicação não interpreta nomes como caminhos de objeto.

Exemplo de claims operacionais (não é um token/credencial):

```json
{ "sub": "operator-subject", "roles": ["operator"], "scope": "quarantine:read" }
```

Ainda é necessário provisionar `operator_grants` para o issuer/sub autenticado,
ação `quarantine.read`. O ator administrativo precisa ser estabelecido pelo canal
de provisionamento confiável descrito na ADR. Não enviar JWT ou credenciais em chat,
URL ou logs para configurar isso. Tokens operacionais não exigem provider fictício.

## Política de `/metrics`

`MetricsAccessGuard` verifica JWT e usa a mesma `AdministrativeClaimsPolicy`.
Não consulta grants/financeiro no PostgreSQL: a autorização de métricas é a
permissão explícita assinada pelo IdP para um papel operacional. Assim, uma falha
de banco em tempo de execução não cria uma dependência adicional para o scrape.
Essa permissão dá acesso a métricas agregadas globais; não é um extrato por provider.
Concessão/revogação é administrada no IdP e limitada pela expiração do token.

| `METRICS_ACCESS` | Comportamento |
|---|---|
| `auto` (padrão) | OIDC: autenticado por papel + permission. Challenge em dev/test: público. Challenge com `NODE_ENV=production`: desabilitado (404). |
| `authenticated` | Exige JWT válido, papel operacional/admin e permissão de métricas, inclusive se challenge estiver habilitado para finanças. |
| `disabled` | 404 para todos, sem retornar métricas. |
| `public` | Permitido somente com challenge e fora de production; em OIDC/production falha fechada com 503. |

Valor desconhecido/vazio falha com 503. Health permanece público. Em ambientes
externos, configure OIDC/produção, mantenha `auto`, `authenticated` ou `disabled` e
restrinja a rota à rede do coletor. Challenge dev/test é deliberadamente compatível
com o desafio e não é um perfil de exposição externa. O coletor deve obter seu JWT
no IdP e enviá-lo em Authorization, nunca como query parameter.

## Auditoria e dados sensíveis

Decisões autenticadas da quarentena são persistidas em `authorization_audit` com
issuer/sub, ação, recurso, decisão, origem e correlação. Permissão de resolução e
alteração de status/nota participam do mesmo commit. Tokens rejeitados antes de
estabelecer identidade não são atribuídos a um ator fictício no banco.

Logs de aplicação emitem somente evento, allow/deny e correlação; não incluem
JWT, claims, nota de investigação, raw payload ou credenciais. A nota continua no
registro operacional existente, protegido, e não é copiada ao audit trail de
autorização. Métricas registram decisões em log sem consultar o banco. Use retenção
restrita para registros operacionais e auditoria; a conta de desenvolvimento do
Compose não substitui papéis PostgreSQL separados em produção.

Sem migrations novas nesta tarefa. `AUTH_MODE=challenge` mantém operações locais
do desafio; o endurecimento administrativo aplica-se em OIDC e a proteção de
métricas segue a matriz explícita acima.

O [procedimento de rollout](OIDC_ROLLOUT.md) contém plano explícito, geração de
configuração OAuth2 do coletor e aplicação atômica/idempotente dos subjects aprovados.
A ferramenta não configura um IdP desconhecido nem descobre/aprova identidades.

Tarefa 6: redrive exige também permission configurável
`OIDC_QUARANTINE_REDRIVE_PERMISSION` (padrão `quarantine:redrive`) e grant
`quarantine.redrive`; read/resolve não concedem redrive. Consulte
[QUARANTINE_RECOVERY](QUARANTINE_RECOVERY.md) para leases, idempotência e estados.

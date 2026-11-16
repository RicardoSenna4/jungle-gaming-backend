# OIDC/JWT: configuração e limites de segurança

`AUTH_MODE=challenge` mantém o desafio. OIDC e métricas autenticadas validam
configuração no OnModuleInit, antes de servir: issuer/audience obrigatórios, URLs
aceitáveis e parâmetros numéricos válidos. Configuração inválida aborta startup.
A disponibilidade/chaves do IdP é verificada no primeiro token: sem chaves válidas
não há aceitação. Health não constitui prova de disponibilidade do IdP.

Issuer é comparado exatamente, sem retirar slash da claim/configuração. Discovery
precisa devolver o mesmo issuer. JWKS descoberto deve ficar no origin do issuer ou
num origin HTTPS explicitamente declarado em `OIDC_JWKS_ALLOWED_ORIGINS` (CSV de
origins sem paths). `OIDC_JWKS_URI` explícito é configuração administrativa confiável,
mas também passa por política de URL/DNS. Headers JWT jku/x5u não dirigem fetches.

HTTPS/certificados são obrigatórios. Userinfo, query/fragment, redirects, endereços
privados/reservados/metadata e respostas DNS com qualquer destino bloqueado são
rejeitados. A conexão usa o IP validado, com Host/SNI originais e verificação TLS,
evita rebinding entre validação e conexão. Não herda proxy arbitrário do ambiente:
IdP precisa de egress direto autorizado. IdPs privados não são suportados por essa
política; requerem desenho explícito de trust/egress, não desabilitar verificações.

Exceção local: `OIDC_ALLOW_LOOPBACK_HTTP=true` **e** NODE_ENV test/development permite
apenas literal loopback/localhost resolvido exclusivamente para loopback. Produção
não habilita a exceção. Não usar redes privadas inteiras como substituto.

JWT: exatamente três segmentos base64url canônicos, limite 16 KiB, JSON objeto,
RS256 com kid não vazio limitado, sem crit/b64 alternativos. Audience string/array
válido, subject/provider não vazios e NumericDate inteiros finitos. exp é obrigatório;
nbf/iat são validados quando presentes. JWK pública RSA >=2048, use/alg/key_ops
compatíveis, sem componentes privados, kids duplicados ou campos malformados.
JWKS tem até 32 chaves e resposta de rede limitada a 256 KiB.

Cache: TTL de `OIDC_JWKS_CACHE_TTL_SECONDS` (1–3600, padrão 300). Refresh substitui
atomicamente o conjunto, removendo chaves ausentes. Coalescência de requisições em
voo e cooldown global `OIDC_JWKS_REFRESH_COOLDOWN_MS` (10–60000 ms, padrão 1000)
limitam ataques com kids aleatórios/assinaturas falsas. Kid novo e mesma-kid com
assinatura divergente podem atualizar após cooldown; rotação deve preservar overlap
adequado no IdP. Cache não é usado depois da expiração durante falha de refresh.

`OIDC_HTTP_TIMEOUT_MS`: 50–30000 ms, padrão 3000, inclui DNS/conexão/leitura.
`OIDC_CLOCK_SKEW_SECONDS`: 0–300, padrão 30. Números inválidos não recebem fallback
silencioso. Issuer/audience/config são imutáveis por instância: alterações exigem reinício e
requisições com configuração divergente falham fechadas, sem reutilizar chaves de outro issuer. Erros expõem somente
códigos constantes (401 token inválido; 503 configuração/IdP indisponível), nunca
JWT, resposta remota, chave, credenciais ou URL fornecida pelo atacante em logs.

Limites: não há introspecção/revogação imediata por jti; tokens válidos seguem exp
com skew. Chave retirada pode permanecer aceita até refresh/TTL; ajustar overlap e
TTL ao risco operacional. Não se afirma teste de IdP gerenciado externo ou proxy/VPN
real a partir dos testes locais. Use rate limit/egress e IdP confiável no deploy.

IPv6 é comparado por prefixos binários, inclusive formas comprimidas. Teredo,
benchmark/documentação, 6to4 e endereços com zone ID não entram como destinos
públicos; um caso de IPv6 global é verificado positivamente nos testes.

OIDC_JWKS_URI ausente ou vazio usa discovery validado; issuer/audience vazios
continuam erros de configuração. Isso preserva o uso do arquivo .env.example.

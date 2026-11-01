# shared/auth

Autenticação por JWT de um IdP externo (R-02-03, D10.1). O ponto de extensão é o `ProviderIdentityPort` (R-02-05).

| Arquivo | O que é |
|---|---|
| `provider-identity.port.ts` | `ProviderIdentityPort.authenticate(token)` → `Identity { subject, roles, providerId? }`. |
| `jose-provider-identity.ts` | Adaptador `jose`: JWKS remoto, emissor, audiência, expiração, só `RS256` (D16.1). A busca do JWKS passa por um `fetch` próprio que transforma emissor indisponível em erro transitório (D16.16). |
| `auth.guard.ts` | Guard global (`APP_GUARD`): exige `Authorization: Bearer …`, salvo `@Public()`; confere `@Roles(...)`. Roda antes da validação do schema; o parse do JSON é anterior a ele (D16.15). |
| `auth.decorators.ts` | `@Public()`, `@Roles()`, `@CurrentIdentity()`. |
| `auth.config.ts` | `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_JWKS_URL` e `AUTH_JWKS_TIMEOUT_MS` (padrão 5 s), validados com zod. Só o processo `api` lê. |

## Regras

- Papéis em `realm_access.roles` (`provider`, `operator`); provedor em `provider_id` (D16.1). Token sem papel conhecido, ou `provider` sem `provider_id` → `401`. Um token com os dois papéis tem as permissões dos dois (D16.10).
- Sem token, token inválido, expirado, de outro emissor ou audiência, assinado com outra chave, ou outro algoritmo → `401 UNAUTHENTICATED`. Papel sem permissão → `403 FORBIDDEN` (D10.2, D16.2).
- JWKS do emissor indisponível (resposta não-200, conexão recusada ou sem resposta em `AUTH_JWKS_TIMEOUT_MS`) → `503 TEMPORARILY_UNAVAILABLE` com `Retry-After: 1` (D16.16, D16.3). O token pode ser válido; a falha é do IdP.
- O corpo é lido antes do guard: JSON mal formado → `400` mesmo sem token. Corpo JSON fora do schema, sem token → `401` (D16.15).
- **Não existe chave para desligar a autenticação** (D10.3). Os testes usam um emissor de teste: um par RSA e um JWKS servido por HTTP de verdade (`test/support/auth.ts`). A validação é o mesmo adaptador da produção.
- Health e `/docs` são abertos (R-02-06, D13.2). A fila não tem auth (R-02-07).
- O token nunca é logado (D11.1).

O container do Keycloak entra na S10 (D10.4). Até lá, as variáveis do Compose apontam para onde ele vai ficar.

## Testes

`test/integration/auth/auth.spec.ts`; os três casos do JWKS indisponível em `test/integration/auth/jwks-unavailable.spec.ts`.

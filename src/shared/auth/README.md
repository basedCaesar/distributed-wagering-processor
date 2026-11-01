# shared/auth

Autenticação por JWT de um IdP externo (R-02-03, D10.1). O ponto de extensão é o `ProviderIdentityPort` (R-02-05).

| Arquivo | O que é |
|---|---|
| `provider-identity.port.ts` | `ProviderIdentityPort.authenticate(token)` → `Identity { subject, roles, providerId? }`. |
| `jose-provider-identity.ts` | Adaptador `jose`: JWKS remoto, emissor, audiência, expiração, só `RS256` (D16.1). |
| `auth.guard.ts` | Guard global (`APP_GUARD`): exige `Authorization: Bearer …`, salvo `@Public()`; confere `@Roles(...)`. Roda antes dos pipes. |
| `auth.decorators.ts` | `@Public()`, `@Roles()`, `@CurrentIdentity()`. |
| `auth.config.ts` | `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_JWKS_URL`, validados com zod. Só o processo `api` lê. |

## Regras

- Papéis em `realm_access.roles` (`provider`, `operator`); provedor em `provider_id` (D16.1). Token sem papel conhecido, ou `provider` sem `provider_id` → `401`. Um token com os dois papéis tem as permissões dos dois.
- Sem token, token inválido, expirado, de outro emissor ou audiência, assinado com outra chave, ou outro algoritmo → `401 UNAUTHENTICATED`. Papel sem permissão → `403 FORBIDDEN` (D10.2, D16.2). JWKS sem resposta → `503` (transitório).
- **Não existe chave para desligar a autenticação** (D10.3). Os testes usam um emissor de teste: um par RSA e um JWKS servido por HTTP de verdade (`test/support/auth.ts`). A validação é o mesmo adaptador da produção.
- Health e `/docs` são abertos (R-02-06, D13.2). A fila não tem auth (R-02-07).
- O token nunca é logado (D11.1).

O container do Keycloak entra na S10 (D10.4). Até lá, as variáveis do Compose apontam para onde ele vai ficar.

## Testes

`test/integration/auth/auth.spec.ts`.

# keycloak

IdP externo da api (R-02-03, D10.1). O Keycloak sobe no Compose de dev (porta 8080) e no de teste (porta 8081, só para o e2e), com `start-dev --import-realm`, e importa o realm deste diretório (D23.4).

| Arquivo | O que é |
|---|---|
| `realm-wagering.json` | Realm `wagering`: papéis, clients, mappers e as contas de serviço. |

## Realm `wagering`

- Papéis de realm: `provider` e `operator`. Vão no token em `realm_access.roles` (D16.1).
- Clients confidenciais, **só `client_credentials`** (sem fluxo de usuário, sem senha direta):

| Client | Papel | Claim `provider_id` |
|---|---|---|
| `provider-a` | `provider` | `provider-a` |
| `provider-b` | `provider` | `provider-b` |
| `operator` | `operator` | — |

- Cada client tem um mapper de audiência (`aud` contém `wagering-api`, o `AUTH_AUDIENCE` da api). Os provedores têm um mapper de claim fixo `provider_id` = o id do client. A api confere o `provider_id` contra o `providerId` do corpo (D10.2).
- O papel é dado à conta de serviço de cada client (`users[].serviceAccountClientId`).
- Token de acesso de 5 minutos.
- **Os segredos (`<client>-dev-secret`) e o admin (`admin`/`admin`) são de desenvolvimento, não segredos reais.** Em produção, viriam de um cofre (D12.3).

`provider-b` existe para os casos de `403` (submeter com o `providerId` de outro provedor) e `404` (consultar a transação de outro provedor).

## Emissor (D23.3)

O `iss` do token depende do host que o Keycloak considera seu. Com `KC_HOSTNAME=http://localhost:8080`, ele é sempre `http://localhost:8080/realms/wagering`, qualquer que seja o host usado para pedir o token. A api usa esse valor em `AUTH_ISSUER`. Com `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true`, as chamadas pela rede interna usam o host da própria requisição, e a api busca o JWKS em `http://keycloak:8080/realms/wagering/protocol/openid-connect/certs`, sem sair da rede do Compose. No Compose de teste, o mesmo com a porta 8081 (`E2E_KEYCLOAK_URL` do `.env.test`).

O healthcheck usa o `/health/ready` da porta de gestão (9000). A imagem não tem `curl`, então a chamada sai pelo `/dev/tcp` do bash.

## Como pegar um token

Ver [README da raiz, "Token"](../README.md#token-keycloak-d101-d23).

## Testes

| O quê | Onde |
|---|---|
| Papéis, `provider_id`, audiência e só `client_credentials` no realm | `test/unit/keycloak-realm.spec.ts` |
| `AUTH_ISSUER` = `KC_HOSTNAME` + `/realms/wagering`, JWKS interno, realm montado, porta do teste | `test/integration/infra/compose-topology.spec.ts` |
| Token real → `201`, `200`, `403` e `404` pela api | `test/e2e/keycloak.spec.ts` |
| Os exemplos do §9 com o token do Keycloak | `bun run acceptance` |

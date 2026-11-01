# shared/http

Peças HTTP comuns a todos os módulos.

| Arquivo | O que é | Regras |
|---|---|---|
| `correlation.middleware.ts` | Lê o `X-Correlation-Id` (válido = `^[A-Za-z0-9._:-]{1,128}$`) ou gera um UUIDv7, devolve no header da resposta e põe no contexto do logger. Gera também o id da requisição, que vira o `causationId` dos eventos. `@CurrentRequestMeta()` entrega os dois ao controller. | D9.5, D11.1, D16.7 |
| `zod.ts` | `parseOrThrow(schema, input)`: falha → `ValidationError` (`400`), com caminho e mensagem de cada problema, sem o valor recebido. | D5, D11.1 |
| `swagger.ts` | `/docs` e `/docs-json`, com o esquema Bearer. Fora dos controllers, então aberto. | D13.2 |
| `error-responses.ts` | `@ApiErrorResponses(...)`: documenta os status de erro da D5 de um endpoint. | D13.2 |

Testes: `test/integration/wallets/create-wallet.spec.ts` (correlação) e `test/integration/docs/swagger.spec.ts`.

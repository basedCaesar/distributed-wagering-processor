# shared/http

Peças HTTP comuns a todos os módulos.

| Arquivo | O que é | Regras |
|---|---|---|
| `correlation.middleware.ts` | Lê o `X-Correlation-Id` (válido = `^[A-Za-z0-9._:-]{1,128}$`) ou gera um UUIDv7, devolve no header da resposta e põe no contexto do logger. Gera também o id da requisição, que vira o `causationId` dos eventos. `@CurrentRequestMeta()` entrega os dois ao controller. | D9.5, D11.1, D16.7 |
| `zod.ts` | `parseOrThrow(schema, input)`: falha → `ValidationError` (`400`), com caminho e mensagem de cada problema, sem o valor recebido. | D5, D11.1 |
| `swagger.ts` | `/docs` e `/docs-json`, com o esquema Bearer. Fora dos controllers, então aberto. | D13.2 |
| `error-responses.ts` | `@ApiErrorResponses(...)`: documenta os status de erro da D5 de um endpoint. | D13.2 |
| `request-deadline.ts` | Prazo de cada requisição: o middleware marca a chegada (o prazo inclui o guard) e o interceptor global corta no que sobra de `HTTP_REQUEST_TIMEOUT_MS` (10 s) com `RequestDeadlineExceededError`, um `TransientError` → `503 TEMPORARILY_UNAVAILABLE` + `Retry-After: 1`. O trabalho em andamento **não** é cancelado: se commitar depois, o reenvio com a mesma key é replay. O desfecho tardio é logado ("requisição commitou depois do prazo" ou "requisição falhou depois do prazo", o erro por `classifyError()`), com `correlationId`, `idempotencyKey`, método e rota, sem o corpo. | D5, D3.4, D11.1, D21.3 |

O shutdown da api (readiness falsa, para de aceitar, drena até o mesmo prazo, só então fecha o banco) está em `src/app/api-shutdown.ts` (D8.6, D21.2).

Testes: `test/integration/wallets/create-wallet.spec.ts` (correlação), `test/integration/docs/swagger.spec.ts`, `test/integration/http/request-timeout.spec.ts` (prazo) e `test/integration/shutdown/shutdown.spec.ts` (shutdown).

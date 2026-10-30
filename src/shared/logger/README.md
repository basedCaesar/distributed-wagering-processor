# shared/logger

Logs JSON com `pino` (D11.1). O contexto da operação entra em toda linha sozinho, via `AsyncLocalStorage`.

- `request-context.ts`: `runWithContext(ctx, fn)` e `getContext()`. Campos: `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`.
- `logger.ts`: o `logger` com um `mixin` que injeta o contexto atual.

## Regras

- **Nunca** logar valores, saldos, payloads, o header `Authorization` nem o `playerId` (D11.1). Por isso o contexto não tem esses campos.
- Quem abre a operação (HTTP, consumidor, worker) chama `runWithContext`; o resto só usa `logger`.

## Testes

`test/unit/request-context.spec.ts`.

# shared/logger

Logs JSON com `pino` (R-12-01, R-12-02, D11.1, D22.9). O contexto da operação entra em toda linha sozinho, via `AsyncLocalStorage`.

- `request-context.ts`:
  - `runWithContext(ctx, fn)` e `getContext()`, com os campos `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`;
  - `enrichContext(fields)` acrescenta ids à operação em andamento (D22.9 a): o controller põe `providerId` e `walletId` depois da validação e o `transactionId` depois do resultado; o consumidor põe o `transactionId` depois do use case.
- `logger.ts`: o `logger` do processo e `createLogger(destino)` (para os testes), com:
  - `mixin`: injeta o contexto atual em toda linha;
  - `redact` (D22.9 c): `authorization`, `playerId`, `amount`, `money`, `balance`, `balanceAfter`, `balanceBefore`, `initialBalance`, `payload` e `body` no 1º e no 2º nível, mais `*.headers.authorization`, viram `[REDACTED]`. É defesa em profundidade: o código já não loga nada disso;
  - serializer de erro `err`/`error` (D22.9 e): só `type`, `code`, `constraint` e `table`, cada um conferido contra o formato (SQLSTATE, identificador). **Nunca** a `message` (o MikroORM põe a query nela), o `detail` do `pg` ("Failing row contains (...)", com a linha inteira), o `where`, os parâmetros nem o stack;
  - hook `logMethod`: `logger.error(err)` não usa a `message` do erro como `msg`.

## Fluxos

| Fluxo | Quem abre o contexto | Linha com os campos |
|---|---|---|
| HTTP | `CorrelationMiddleware` (`correlationId`) + `enrichContext` no controller | `"requisição concluída"` (`AccessLogMiddleware`, `shared/http/`): método, rota em padrão, status, `durationMs`; sem `/health/*` e `/docs*` |
| SQS | `SqsConsumer` (`correlationId` = `messageId`, `walletId`, `providerId`) + `enrichContext` | `"mensagem processada"`, com os 5 campos |
| worker | `PendingWorker` (`transactionId`, `walletId`) | as da tentativa |
| publisher | `OutboxPublisher` (`walletId`, `correlationId` do evento) | as da publicação |

O fluxo HTTP não tem `messageId` (D22.9 d).

## Regras

- **Nunca** logar valores, saldos, payloads, o header `Authorization` nem o `playerId` (D11.1). Por isso o contexto não tem esses campos.
- Um erro vai para o log pelo `classifyError()` (`category`, `code` e, se for do banco, `db.sqlState`, `db.constraint`, `db.table`) ou pelo serializer acima; **nunca** o objeto de erro cru com campos copiados à mão.
- Quem abre a operação (HTTP, consumidor, worker) chama `runWithContext`; o resto só usa `logger`.

## Testes

- `test/unit/request-context.spec.ts`: o contexto por `AsyncLocalStorage`;
- `test/unit/logger/redaction.spec.ts`: o `redact` no 1º e no 2º nível, o serializer de erro e o erro como 1º argumento;
- `test/integration/observability/pg-error-logs.spec.ts`: um `CHECK` violado de verdade (pelo `pg`, pelo MikroORM, pelo HTTP e pela fila) com valor e `playerId` distintivos: nenhum dos dois aparece em nenhuma linha;
- `test/integration/observability/log-fields.spec.ts`: os processos reais `api` e `consumer`; os campos do R-12-01 nas linhas do fluxo HTTP e do SQS, e nenhum valor, saldo, `playerId` ou token no stdout;
- `test/integration/logging/sensitive-data.spec.ts`: a divergência de reconciliação e o `500`.

# shared/errors

Mapeamento de erros para HTTP (D5). Todo erro que chega à borda passa por `classifyError()`.

| Arquivo | O que é |
|---|---|
| `app-errors.ts` | Classes base com categoria: `ValidationError`, `UnauthenticatedError`, `ForbiddenError`, `NotFoundError`, `ConflictError(code)`, `TransientError`. Os módulos estendem estas; o `classifyError` não conhece módulo nenhum. |
| `classify-error.ts` | `classifyError(error)` → `{ category, httpStatus, code, message, details? }`. |
| `http-exception.filter.ts` | Filtro global: corpo `{ error: { code, message, details? } }`, `Retry-After: 1` no `503` (D16.3), log de erros internos e transitórios. |

## Classificação

| Categoria | Status | Código (D16.2) | Exemplos |
|---|---|---|---|
| validação | `400` | `VALIDATION_ERROR` | zod, cursor, JSON mal formado |
| sem token | `401` | `UNAUTHENTICATED` | |
| sem permissão | `403` | `FORBIDDEN` | |
| não encontrado | `404` | `NOT_FOUND` | wallet, rota |
| conflito | `409` | o do erro | `WALLET_ALREADY_EXISTS` |
| transitório | `503` | `TEMPORARILY_UNAVAILABLE` | SQLSTATE `55P03` (lock_timeout), `57014` (statement_timeout), `40P01`, `40001`, classes `08`, `53`, `57P`; `ECONNREFUSED` e afins; `ConnectionException` |
| interno | `500` | `INTERNAL_ERROR` | erro de domínio que escapou da borda, constraint sem tradução, qualquer outra coisa |

Uma constraint violada que o repositório não traduziu para um erro de aplicação é bug, não conflito: vira `500`. A mensagem de um erro interno não vaza para o cliente, e o log leva só nome, SQLSTATE e constraint, nunca o `detail` do banco, que pode trazer valores (D11.1).

## Testes

`test/unit/errors/classify-error.spec.ts`; o corpo e os status pela API em `test/integration/wallets/` e `test/integration/auth/`.

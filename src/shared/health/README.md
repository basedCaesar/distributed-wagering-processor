# shared/health

Liveness e readiness (D11.3, R-12-04). Abertos, sem autenticação (D10.2): o controller é `@Public()`, então o guard global não o alcança. Documentados no Swagger (D13.2).

| Rota | Responde |
|---|---|
| `GET /health/live` | `200 { status: "ok" }` enquanto o processo responde |
| `GET /health/ready` | `200` se Postgres **e** SQS respondem; senão `503`, com o resultado de cada um |

- `postgres-health-check.ts`: conecta com as credenciais do `SecretsProvider` e roda `SELECT 1`.
- `sqs-health-check.ts`: `GetQueueAttributes` na fila de transações.
- `with-timeout.ts`: cada checagem tem o timeout de `HEALTH_CHECK_TIMEOUT_MS` (1 s); o que não responde a tempo conta como fora.

## Regras

- A API não depende do SQS para aceitar transações (publica pela outbox), mas a readiness fica falsa sem ele, porque "pronto" é Postgres e SQS alcançáveis (D5, "Infra fora"). O nginx não roteia pela readiness.
- No shutdown, a readiness fica falsa de vez (`markShuttingDown()`, chamado pelo `ApiShutdown` antes de o servidor parar de aceitar, D8.6), sem consultar Postgres nem SQS.

## Testes

`test/integration/health.spec.ts`: readiness falsa com porta sem serviço e com host não roteável. Sem token, com o guard ligado: `test/integration/auth/auth.spec.ts`. SQS fora com a submissão funcionando: `test/integration/failures/sqs-down.spec.ts`. Readiness falsa no shutdown: `test/integration/shutdown/shutdown.spec.ts`.

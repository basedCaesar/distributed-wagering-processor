/**
 * Ambiente do `accounting-consumer` num processo separado (D27.6): o papel
 * `accounting_app` no lugar do da app (como no Compose) e, se o teste
 * passar, as filas dele.
 */
export function accountingProcessEnv(queues?: { queueName: string; dlqName: string }): Record<string, string> {
  return {
    DB_USER: process.env.DB_ACCOUNTING_USER ?? "accounting_app",
    DB_PASSWORD: process.env.DB_ACCOUNTING_PASSWORD ?? "",
    ...(queues !== undefined && {
      QUEUE_ACCOUNTING_EVENTS: queues.queueName,
      QUEUE_ACCOUNTING_EVENTS_DLQ: queues.dlqName,
    }),
  };
}

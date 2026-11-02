/** Prazos do banco (D5): lock com timeout vira 503 transitório. */
export const LOCK_TIMEOUT_MS = 2_000;
export const STATEMENT_TIMEOUT_MS = 5_000;
export const LOCK_TIMEOUT = `${LOCK_TIMEOUT_MS}ms`;
export const STATEMENT_TIMEOUT = `${STATEMENT_TIMEOUT_MS}ms`;

/**
 * Parâmetros de sessão enviados no startup de cada conexão do `pg`,
 * então valem para toda conexão do pool, sem depender de um `SET` manual.
 * O `application_name` (D21.1) liga a sessão ao processo no `pg_locks` e
 * no `pg_stat_activity`; o formato dele (sem espaço) é validado na config.
 */
export function sessionOptions(applicationName?: string): string {
  const base = `-c lock_timeout=${LOCK_TIMEOUT} -c statement_timeout=${STATEMENT_TIMEOUT}`;
  return applicationName === undefined ? base : `${base} -c application_name=${applicationName}`;
}

/** Prazos do banco (D5): lock com timeout vira 503 transitório. */
export const LOCK_TIMEOUT = "2s";
export const STATEMENT_TIMEOUT = "5s";

/**
 * Parâmetros de sessão enviados no startup de cada conexão do `pg`,
 * então valem para toda conexão do pool, sem depender de um `SET` manual.
 */
export const SESSION_OPTIONS = `-c lock_timeout=${LOCK_TIMEOUT} -c statement_timeout=${STATEMENT_TIMEOUT}`;

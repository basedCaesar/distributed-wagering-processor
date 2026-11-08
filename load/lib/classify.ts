/**
 * Desfecho de cada resposta da submissão sob carga (D26.5). Código puro:
 * roda no k6 (a cada resposta) e nos testes de unidade.
 *
 * - `200` `PROCESSED` e `422` `REJECTED` são resultados corretos (D5);
 * - `503` é transitório: o cliente reenvia com a mesma key, como o provedor;
 * - o resto é status inesperado e reprova o `test:load` (D26.6). A carga não
 *   manda referência, então nem o `202` é esperado.
 */

export type SubmissionOutcome =
  | { outcome: "processed"; replay: boolean }
  | { outcome: "rejected"; replay: boolean; failureCode: string }
  | { outcome: "transient" }
  | { outcome: "unexpected"; errorCode?: string };

function asRecord(body: unknown): Record<string, unknown> | undefined {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : undefined;
}

function errorCodeOf(body: Record<string, unknown> | undefined): string | undefined {
  const code = asRecord(body?.error)?.code;
  return typeof code === "string" ? code : undefined;
}

export function classifySubmission(status: number, body: unknown): SubmissionOutcome {
  if (status === 503) return { outcome: "transient" };
  const record = asRecord(body);
  const replay = record?.idempotentReplay;
  if (status === 200 && record?.status === "PROCESSED" && typeof replay === "boolean") {
    return { outcome: "processed", replay };
  }
  if (
    status === 422 &&
    record?.status === "REJECTED" &&
    typeof record.failureCode === "string" &&
    typeof replay === "boolean"
  ) {
    return { outcome: "rejected", replay, failureCode: record.failureCode };
  }
  const errorCode = errorCodeOf(record);
  return errorCode === undefined ? { outcome: "unexpected" } : { outcome: "unexpected", errorCode };
}

const DEFAULT_RETRY_AFTER_S = 1;
const MAX_RETRY_AFTER_S = 10;

/** Espera antes do reenvio: o `Retry-After` (D5) em segundos, entre 1 e 10. */
export function retryAfterSeconds(header: string | undefined): number {
  if (header === undefined || !/^\d+$/.test(header)) return DEFAULT_RETRY_AFTER_S;
  const seconds = Number(header);
  if (seconds < 1) return DEFAULT_RETRY_AFTER_S;
  return Math.min(seconds, MAX_RETRY_AFTER_S);
}

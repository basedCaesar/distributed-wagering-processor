export interface OutboxPolicy {
  /** Cabeças de wallet por claim (D9.6, D20.3). */
  batchSize: number;
  /** Lease do claim (D9.6). Nos processos, vem de `OUTBOX_LEASE_MS` (D20.5). */
  leaseMs: number;
  /** Espera depois de um claim vazio (D20.3). */
  idleMs: number;
  /** Teto do backoff de 2ⁿ s (D9.6, D20.4). */
  backoffMaxSeconds: number;
  /** A partir desta tentativa, cada falha é um alerta (D9.6, D20.4). */
  alertAfterAttempts: number;
}

export const OUTBOX_POLICY: OutboxPolicy = {
  batchSize: 50,
  leaseMs: 30_000,
  idleMs: 500,
  backoffMaxSeconds: 300,
  alertAfterAttempts: 20,
};

/** 2ⁿ s, n = a tentativa que acabou de falhar (começa em 1), até o teto (D20.4). */
export function outboxBackoffSeconds(
  attempt: number,
  maxSeconds = OUTBOX_POLICY.backoffMaxSeconds,
): number {
  return Math.min(2 ** attempt, maxSeconds);
}

/** O evento já falhou `attempts` vezes: alerta, sem nunca descartar (D9.6, D20.4). */
export function stalled(attempts: number, alertAfter = OUTBOX_POLICY.alertAfterAttempts): boolean {
  return attempts >= alertAfter;
}

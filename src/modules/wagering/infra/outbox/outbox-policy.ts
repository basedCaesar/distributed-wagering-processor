/**
 * Valores operacionais do publisher. O backoff (D20.4) e o limite de
 * alerta (D9.6) são regras do `OutboxMessage`, no domínio (D24).
 */
export interface OutboxPolicy {
  /** Cabeças de wallet por claim (D9.6, D20.3). */
  batchSize: number;
  /** Lease do claim (D9.6). Nos processos, vem de `OUTBOX_LEASE_MS` (D20.5). */
  leaseMs: number;
  /** Espera depois de um claim vazio (D20.3). */
  idleMs: number;
}

export const OUTBOX_POLICY: OutboxPolicy = {
  batchSize: 50,
  leaseMs: 30_000,
  idleMs: 500,
};

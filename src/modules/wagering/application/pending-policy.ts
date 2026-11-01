/**
 * Reprocessamento das `PENDING_REFERENCE` (D4.2, D4.3, D18.1, D18.2, D18.5).
 * Funções puras sobre datas: quem chama passa o relógio.
 */
export const PENDING_POLICY = {
  /** Prazo desde a criação (D4.3). */
  deadlineMs: 15 * 60 * 1000,
  /** Backoff exponencial: 1 s, dobrando até 60 s (D4.3). */
  baseDelayMs: 1000,
  maxDelayMs: 60 * 1000,
  /** Lease do claim (D18.2). */
  leaseMs: 30 * 1000,
  /** Lote do claim (D18.2). */
  batchSize: 10,
  /** Intervalo do worker (D4.3). */
  tickMs: 1000,
  /** Erros seguidos até o `FAILED` (D4.2, D18.4). */
  maxConsecutiveErrors: 5,
} as const;

/** Maior expoente útil: 2^6 s já passa do teto de 60 s. */
const MAX_EXPONENT = 16;

/**
 * Próxima tentativa depois da tentativa número `attempts` (≥ 1):
 * `min(2^(attempts−1) s, 60 s)` a partir de `now`. Nunca passa do fim do
 * prazo enquanto ele está à frente (D18.5); depois dele (tentativa que deu
 * erro), vale o backoff.
 */
export function nextAttemptAt(input: {
  attempts: number;
  createdAt: Date;
  now: Date;
}): Date {
  const exponent = Math.min(Math.max(input.attempts - 1, 0), MAX_EXPONENT);
  const delay = Math.min(
    PENDING_POLICY.baseDelayMs * 2 ** exponent,
    PENDING_POLICY.maxDelayMs,
  );
  const next = input.now.getTime() + delay;
  const deadline = deadlineOf(input.createdAt);
  if (deadline > input.now.getTime() && next > deadline) {
    return new Date(deadline);
  }
  return new Date(next);
}

/** O prazo de 15 min desde a criação passou (R-07-21, D4.3). */
export function isExpired(createdAt: Date, now: Date): boolean {
  return now.getTime() >= deadlineOf(createdAt);
}

/** `consecutiveErrors` já contando o erro atual (D4.2, D18.4). */
export function reachedErrorLimit(consecutiveErrors: number): boolean {
  return consecutiveErrors >= PENDING_POLICY.maxConsecutiveErrors;
}

function deadlineOf(createdAt: Date): number {
  return createdAt.getTime() + PENDING_POLICY.deadlineMs;
}

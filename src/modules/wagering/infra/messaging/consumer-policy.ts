import type { ErrorCategory } from "../../../../shared/errors/classify-error";

export interface ConsumerPolicy {
  /** Chave da inbox e do `message_attempts` com o `messageId` (D3.7). */
  consumerName: string;
  /** Long poll (D19.6). */
  waitTimeSeconds: number;
  /** Mensagens por receive (D19.6). */
  maxMessages: number;
  /**
   * Visibilidade no receive (D19.6): 10 mensagens de um grupo × (2 s de
   * `lock_timeout` + 5 s de `statement_timeout`) = 70 s, mais a repetição
   * da D3.6. Com 60 s, ela venceria no meio do lote.
   */
  visibilityTimeoutSeconds: number;
  /** Falhas contadas antes da DLQ (D8.3). */
  maxAttempts: number;
  /** Teto do backoff de 2ⁿ s (D8.2). */
  backoffMaxSeconds: number;
  /**
   * `SIGTERM`: prazo para terminar o que está em andamento (D8.5): o lote
   * ou o long poll, que não é abortado (D19.9).
   */
  shutdownGraceMs: number;
  /**
   * Depois do prazo, tempo para devolver com visibilidade 0 o que o
   * último receive trouxe (D19.9). 20 s + 5 s cabem nos 30 s do Compose.
   */
  releaseMarginMs: number;
  /** Espera depois do 1º receive que falhou (D19.10). */
  receiveBackoffInitialMs: number;
  /** Teto da espera entre receives que falham (D19.10). */
  receiveBackoffMaxMs: number;
}

export const CONSUMER_POLICY: ConsumerPolicy = {
  consumerName: "wager-transactions-consumer",
  waitTimeSeconds: 20,
  maxMessages: 10,
  visibilityTimeoutSeconds: 120,
  maxAttempts: 8,
  backoffMaxSeconds: 300,
  shutdownGraceMs: 20_000,
  releaseMarginMs: 5_000,
  receiveBackoffInitialMs: 1_000,
  receiveBackoffMaxMs: 30_000,
};

/**
 * Espera antes do próximo receive depois de `failures` receives seguidos
 * que falharam (D19.10): 1 s, dobrando até 30 s. `failures` começa em 1.
 */
export function receiveBackoffMs(
  failures: number,
  initialMs = CONSUMER_POLICY.receiveBackoffInitialMs,
  maxMs = CONSUMER_POLICY.receiveBackoffMaxMs,
): number {
  return Math.min(initialMs * 2 ** (failures - 1), maxMs);
}

/** 2ⁿ s, até o teto (D8.2). `attempt` começa em 1. */
export function backoffSeconds(
  attempt: number,
  maxSeconds = CONSUMER_POLICY.backoffMaxSeconds,
): number {
  return Math.min(2 ** attempt, maxSeconds);
}

/** A falha de número `attempts` esgota o limite (D8.3): vai para a DLQ. */
export function attemptsExhausted(
  attempts: number,
  maxAttempts = CONSUMER_POLICY.maxAttempts,
): boolean {
  return attempts >= maxAttempts;
}

export type Disposition = "dead_letter" | "retry";

/**
 * Erro → destino da mensagem (R-10-06, D8.2). Negócio (`REJECTED`,
 * `PENDING_REFERENCE`, replay) não é erro e recebe ack.
 * - Permanente → DLQ na hora: inválido, wallet inexistente, conflitos de
 *   inbox, de key e de id externo (D19.1).
 * - Transitório e interno → retry contado, DLQ no limite (D8.3, D19.2).
 *   Sem auth na fila (L40), `unauthenticated`/`forbidden` vindos do use
 *   case só sairiam de um bug: contam como internos (D19.2).
 */
const DISPOSITION: Record<ErrorCategory, Disposition> = {
  validation: "dead_letter",
  not_found: "dead_letter",
  conflict: "dead_letter",
  transient: "retry",
  internal: "retry",
  unauthenticated: "retry",
  forbidden: "retry",
};

export function dispositionOf(category: ErrorCategory): Disposition {
  return DISPOSITION[category];
}

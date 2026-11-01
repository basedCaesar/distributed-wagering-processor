import type { MikroORM } from "@mikro-orm/postgresql";
import type { ClaimedPending, PendingQueue } from "../../application/ports";

/**
 * Claim do worker (D4.3, D18.2, D18.9, D18.10), num comando só, então numa
 * transação curta e commitada: escolhe as vencidas e sem lease vigente,
 * pula as travadas (`SKIP LOCKED`), marca o lease com o relógio do banco e
 * o dono (`locked_by`), e devolve em ordem de `next_attempt_at`,
 * `created_at` (e `id`, UUIDv7, no empate exato). Usa o índice
 * `wager_transactions_pending_due_ix`.
 */
const CLAIM_SQL = `
  WITH due AS (
    SELECT id FROM wager_transactions
     WHERE status = 'PENDING_REFERENCE'
       AND next_attempt_at <= now()
       AND (locked_until IS NULL OR locked_until <= now())
     ORDER BY next_attempt_at, created_at, id
     LIMIT ?
     FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE wager_transactions t
       SET locked_until = now() + (? * interval '1 millisecond'),
           locked_by = ?
      FROM due
     WHERE t.id = due.id
    RETURNING t.id, t.wallet_id, t.next_attempt_at, t.created_at
  )
  SELECT id, wallet_id FROM claimed ORDER BY next_attempt_at, created_at, id`;

export class MikroOrmPendingQueue implements PendingQueue {
  constructor(private readonly orm: MikroORM) {}

  async claimDue(limit: number, leaseMs: number, leaseToken: string): Promise<ClaimedPending[]> {
    const rows = await this.orm.em
      .fork()
      .execute<{ id: string; wallet_id: string }[]>(CLAIM_SQL, [limit, leaseMs, leaseToken]);
    return rows.map((row) => ({ id: row.id, walletId: row.wallet_id, leaseToken }));
  }
}

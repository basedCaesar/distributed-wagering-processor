import type { MikroORM } from "@mikro-orm/postgresql";
import type { ClaimedEvent, OutboxStore } from "../outbox/outbox-publisher";

/**
 * Claim por cabeça de wallet (D9.2, D9.6, D20.3, D20.5), num comando só,
 * então numa transação curta e commitada:
 * 1. `heads`: para cada `ordering_key`, o evento não publicado de menor
 *    `position` (índice `outbox_messages_unpublished_ix`). A cabeça é
 *    escolhida **antes** do lock: se ela estiver com lease, em backoff ou
 *    travada, a wallet inteira fica de fora, e o 2º evento nunca sai antes;
 * 2. `due`: as cabeças vencidas e sem lease vigente, `FOR UPDATE SKIP
 *    LOCKED` (outro claim em andamento é pulado, sem esperar);
 * 3. lease (`now()` do banco) e dono (`locked_by`).
 */
const CLAIM_SQL = `
  WITH heads AS (
    SELECT DISTINCT ON (ordering_key) id
      FROM outbox_messages
     WHERE published_at IS NULL
     ORDER BY ordering_key, position
  ), due AS (
    SELECT o.id
      FROM outbox_messages o
      JOIN heads h ON h.id = o.id
     WHERE o.published_at IS NULL
       AND o.next_attempt_at <= now()
       AND (o.locked_until IS NULL OR o.locked_until <= now())
     ORDER BY o.position
     LIMIT ?
     FOR UPDATE OF o SKIP LOCKED
  ), claimed AS (
    UPDATE outbox_messages t
       SET locked_until = now() + (? * interval '1 millisecond'),
           locked_by = ?
      FROM due
     WHERE t.id = due.id
    RETURNING t.id, t.ordering_key, t.event_type, t.payload, t.attempts, t.position
  )
  SELECT id, ordering_key, event_type, payload, attempts FROM claimed ORDER BY position`;

/** Só o dono marca; só o que ainda não foi publicado (D20.5). */
const MARK_PUBLISHED_SQL = `
  UPDATE outbox_messages
     SET published_at = now(), locked_until = NULL, locked_by = NULL
   WHERE id IN (?) AND locked_by = ? AND published_at IS NULL
  RETURNING id`;

/** Tentativa + 1 e backoff com o relógio do banco; lease solto (D9.6, D20.4, D20.5). */
const RECORD_FAILURE_SQL = `
  UPDATE outbox_messages
     SET attempts = attempts + 1,
         last_error_code = ?,
         next_attempt_at = now() + (? * interval '1 second'),
         locked_until = NULL,
         locked_by = NULL
   WHERE id = ? AND locked_by = ? AND published_at IS NULL
  RETURNING attempts`;

interface ClaimRow {
  id: string;
  ordering_key: string;
  event_type: string;
  payload: Record<string, unknown> | string;
  attempts: number;
}

export class MikroOrmOutboxStore implements OutboxStore {
  constructor(private readonly orm: MikroORM) {}

  async claimHeads(limit: number, leaseMs: number, leaseToken: string): Promise<ClaimedEvent[]> {
    const rows = await this.orm.em.fork().execute<ClaimRow[]>(CLAIM_SQL, [limit, leaseMs, leaseToken]);
    return rows.map((row) => ({
      id: row.id,
      orderingKey: row.ordering_key,
      eventType: row.event_type,
      // O MikroORM troca os parsers do `pg`: o `jsonb` pode chegar como texto.
      payload: typeof row.payload === "string" ? (JSON.parse(row.payload) as Record<string, unknown>) : row.payload,
      attempts: row.attempts,
    }));
  }

  async markPublished(ids: readonly string[], leaseToken: string): Promise<string[]> {
    const rows = await this.orm.em.fork().execute<{ id: string }[]>(MARK_PUBLISHED_SQL, [[...ids], leaseToken]);
    return rows.map((row) => row.id);
  }

  async recordFailure(
    id: string,
    leaseToken: string,
    failure: { errorCode: string; backoffSeconds: number },
  ): Promise<number | undefined> {
    const [row] = await this.orm.em
      .fork()
      .execute<{ attempts: number }[]>(RECORD_FAILURE_SQL, [failure.errorCode, failure.backoffSeconds, id, leaseToken]);
    return row?.attempts;
  }
}

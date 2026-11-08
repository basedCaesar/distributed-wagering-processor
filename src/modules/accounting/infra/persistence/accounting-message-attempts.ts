import type { MikroORM } from "@mikro-orm/postgresql";

/** Upsert da tentativa (D8.3), em autocommit: a transação do efeito já foi desfeita. */
const RECORD_ATTEMPT_SQL = `
  INSERT INTO accounting.message_attempts
    (consumer_name, message_id, attempts, last_error_code, first_attempt_at, last_attempt_at)
  VALUES (?, ?, 1, ?, now(), now())
  ON CONFLICT (consumer_name, message_id) DO UPDATE
    SET attempts = accounting.message_attempts.attempts + 1,
        last_error_code = EXCLUDED.last_error_code,
        last_attempt_at = EXCLUDED.last_attempt_at
  RETURNING attempts`;

const CLEAR_ATTEMPTS_SQL = `
  DELETE FROM accounting.message_attempts WHERE consumer_name = ? AND message_id = ?`;

/**
 * As tentativas do `accounting-consumer` (D27.5), na tabela do schema dele.
 * Mesmo contrato do `MessageAttemptsRecorder` do laço genérico (D8.3,
 * D19.11), sem importar a persistência do núcleo (D27.8).
 */
export class MikroOrmAccountingMessageAttempts {
  constructor(private readonly orm: MikroORM) {}

  async record(consumerName: string, messageId: string, errorCode: string): Promise<number> {
    const [row] = await this.orm.em
      .fork()
      .execute<{ attempts: number }[]>(RECORD_ATTEMPT_SQL, [consumerName, messageId, errorCode]);
    if (!row) throw new Error("upsert de accounting.message_attempts não devolveu linha");
    return row.attempts;
  }

  async clear(consumerName: string, messageId: string): Promise<void> {
    await this.orm.em.fork().execute(CLEAR_ATTEMPTS_SQL, [consumerName, messageId]);
  }
}

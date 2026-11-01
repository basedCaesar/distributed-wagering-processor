import type { MikroORM } from "@mikro-orm/postgresql";

/**
 * Upsert da tentativa (D8.3): a primeira falha cria a linha com 1; as
 * seguintes somam 1. Autocommit, fora da transação do use case, que já foi
 * desfeita.
 */
const RECORD_ATTEMPT_SQL = `
  INSERT INTO message_attempts
    (consumer_name, message_id, attempts, last_error_code, first_attempt_at, last_attempt_at)
  VALUES (?, ?, 1, ?, now(), now())
  ON CONFLICT (consumer_name, message_id) DO UPDATE
    SET attempts = message_attempts.attempts + 1,
        last_error_code = EXCLUDED.last_error_code,
        last_attempt_at = EXCLUDED.last_attempt_at
  RETURNING attempts`;

const CLEAR_ATTEMPTS_SQL = `
  DELETE FROM message_attempts WHERE consumer_name = ? AND message_id = ?`;

/** Tentativas que falharam por mensagem (D8.3); nunca o `ApproximateReceiveCount`. */
export interface MessageAttemptsRecorder {
  /** Conta mais uma falha e devolve o total. */
  record(consumerName: string, messageId: string, errorCode: string): Promise<number>;
  /**
   * Apaga as tentativas da mensagem (D19.11): depois do ack e depois da
   * cópia para a DLQ. Uma mensagem devolvida da DLQ começa do zero.
   */
  clear(consumerName: string, messageId: string): Promise<void>;
}

export class MikroOrmMessageAttempts implements MessageAttemptsRecorder {
  constructor(private readonly orm: MikroORM) {}

  async record(consumerName: string, messageId: string, errorCode: string): Promise<number> {
    const [row] = await this.orm.em
      .fork()
      .execute<{ attempts: number }[]>(RECORD_ATTEMPT_SQL, [consumerName, messageId, errorCode]);
    if (!row) throw new Error("upsert de message_attempts não devolveu linha");
    return row.attempts;
  }

  async clear(consumerName: string, messageId: string): Promise<void> {
    await this.orm.em.fork().execute(CLEAR_ATTEMPTS_SQL, [consumerName, messageId]);
  }
}

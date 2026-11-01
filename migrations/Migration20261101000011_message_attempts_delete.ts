import { Migration } from "@mikro-orm/migrations";

/**
 * As tentativas de uma mensagem são apagadas quando ela recebe ack ou vai
 * para a DLQ (D19.11): uma mensagem devolvida da DLQ para a fila começa do
 * zero. Só esta tabela de controle ganha `DELETE`; o ledger, as transações,
 * a inbox e a outbox continuam sem.
 */
export class Migration20261101000011_message_attempts_delete extends Migration {
  override name = "Migration20261101000011_message_attempts_delete";

  override up(): void {
    this.addSql("GRANT DELETE ON message_attempts TO wagering_app;");
  }

  override down(): void {
    this.addSql("REVOKE DELETE ON message_attempts FROM wagering_app;");
  }
}

import { Migration } from "@mikro-orm/migrations";

/**
 * Erros seguidos de uma pendente (D4.2, D18.1). `attempts` conta toda
 * tentativa e define o backoff (D4.3); `consecutive_errors` conta só os
 * erros seguidos e volta a 0 numa tentativa sem erro. Coluna de controle,
 * fora da entidade (D4.5): o trigger de imutabilidade não a vigia, e uma
 * linha terminal continua imutável inteira.
 */
export class Migration20261101000009_pending_consecutive_errors extends Migration {
  override name = "Migration20261101000009_pending_consecutive_errors";

  override up(): void {
    this.addSql(`
      ALTER TABLE wager_transactions
        ADD COLUMN consecutive_errors integer NOT NULL DEFAULT 0,
        ADD CONSTRAINT wager_transactions_consecutive_errors_ck CHECK (consecutive_errors >= 0);`);
  }

  override down(): void {
    this.addSql("ALTER TABLE wager_transactions DROP COLUMN consecutive_errors;");
  }
}

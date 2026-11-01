import { Migration } from "@mikro-orm/migrations";

/**
 * Moeda da transação PROCESSED (R-06-26, D15.10): toda transação aplicada,
 * inclusive LOSS (que não tem lançamento, então a FK da D15.4 não a
 * alcança), tem a moeda da wallet. A coluna gerada é nula fora do
 * PROCESSED, então a REJECTED por CURRENCY_MISMATCH continua aceita.
 */
export class Migration20261031000008_processed_currency extends Migration {
  override name = "Migration20261031000008_processed_currency";

  override up(): void {
    this.addSql(`
      ALTER TABLE wager_transactions
        ADD COLUMN processed_currency char(3)
          GENERATED ALWAYS AS (CASE WHEN status = 'PROCESSED' THEN currency END) STORED;`);
    this.addSql(`
      ALTER TABLE wager_transactions
        ADD CONSTRAINT wager_transactions_processed_currency_fk
          FOREIGN KEY (wallet_id, processed_currency) REFERENCES wallets (id, currency);`);
  }

  override down(): void {
    this.addSql(
      "ALTER TABLE wager_transactions DROP CONSTRAINT wager_transactions_processed_currency_fk;",
    );
    this.addSql("ALTER TABLE wager_transactions DROP COLUMN processed_currency;");
  }
}

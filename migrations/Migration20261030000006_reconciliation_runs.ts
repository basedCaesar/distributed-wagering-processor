import { Migration } from "@mikro-orm/migrations";

/**
 * Execuções de reconciliação, append-only (D6.9). `difference` =
 * armazenado − calculado, com sinal (D2.6); o calculado pode ser negativo
 * se o ledger tiver sido adulterado, então ele não tem CHECK de sinal.
 */
export class Migration20261030000006_reconciliation_runs extends Migration {
  override name = "Migration20261030000006_reconciliation_runs";

  override up(): void {
    this.addSql(`
      CREATE TABLE reconciliation_runs (
        id                  uuid          NOT NULL,
        wallet_id           uuid          NOT NULL,
        currency            char(3)       NOT NULL,
        stored_balance      numeric(20,2) NOT NULL,
        calculated_balance  numeric(20,2) NOT NULL,
        difference          numeric(20,2) NOT NULL,
        checked_entries     integer       NOT NULL,
        consistent          boolean       NOT NULL,
        issues              jsonb         NOT NULL DEFAULT '[]',
        executed_at         timestamptz   NOT NULL,
        CONSTRAINT reconciliation_runs_pk PRIMARY KEY (id),
        CONSTRAINT reconciliation_runs_wallet_fk
          FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
        CONSTRAINT reconciliation_runs_difference_ck
          CHECK (difference = stored_balance - calculated_balance),
        CONSTRAINT reconciliation_runs_checked_entries_ck CHECK (checked_entries >= 0)
      );`);
    this.addSql(`
      CREATE INDEX reconciliation_runs_wallet_ix
        ON reconciliation_runs (wallet_id, executed_at);`);

    this.addSql(`
      CREATE FUNCTION reconciliation_runs_append_only() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'reconciliation_runs é append-only: % recusado', TG_OP
          USING ERRCODE = 'integrity_constraint_violation',
                CONSTRAINT = 'reconciliation_runs_append_only';
      END;
      $$;`);
    this.addSql(`
      CREATE TRIGGER reconciliation_runs_append_only
        BEFORE UPDATE OR DELETE ON reconciliation_runs
        FOR EACH ROW EXECUTE FUNCTION reconciliation_runs_append_only();`);
    this.addSql(`
      CREATE TRIGGER reconciliation_runs_no_truncate
        BEFORE TRUNCATE ON reconciliation_runs
        FOR EACH STATEMENT EXECUTE FUNCTION reconciliation_runs_append_only();`);

    this.addSql("GRANT SELECT, INSERT ON reconciliation_runs TO wagering_app;");
  }

  override down(): void {
    this.addSql("DROP TABLE reconciliation_runs;");
    this.addSql("DROP FUNCTION reconciliation_runs_append_only();");
  }
}

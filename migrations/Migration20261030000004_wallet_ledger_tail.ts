import { Migration } from "@mikro-orm/migrations";

/**
 * Cauda diferida (R-06-21, R-06-27, D7.3, D15.1): no commit, o saldo e a
 * versão da wallet batem com o último lançamento (ou 0 e 1 sem lançamento,
 * D6.2). Pega saldo sem lançamento, lançamento sem saldo e versão que
 * sobe sem mudança de saldo.
 */
export class Migration20261030000004_wallet_ledger_tail extends Migration {
  override name = "Migration20261030000004_wallet_ledger_tail";

  override up(): void {
    this.addSql(`
      CREATE FUNCTION wallets_check_ledger_tail() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        target uuid;
        wallet wallets%ROWTYPE;
        last_entry wallet_ledger_entries%ROWTYPE;
        expected_balance numeric(20,2);
        expected_version integer;
      BEGIN
        -- IF, não CASE: o plpgsql resolve os campos de NEW de cada ramo.
        IF TG_TABLE_NAME = 'wallets' THEN
          target := NEW.id;
        ELSE
          target := NEW.wallet_id;
        END IF;
        SELECT * INTO wallet FROM wallets WHERE id = target;
        SELECT * INTO last_entry FROM wallet_ledger_entries
         WHERE wallet_id = target
         ORDER BY wallet_version DESC LIMIT 1;

        expected_balance := COALESCE(last_entry.balance_after, 0);
        expected_version := COALESCE(last_entry.wallet_version, 1);

        IF wallet.balance <> expected_balance OR wallet.version <> expected_version THEN
          RAISE EXCEPTION 'wallet % diverge do ledger no commit: saldo e versão precisam ser os do último lançamento', target
            USING ERRCODE = 'integrity_constraint_violation',
                  CONSTRAINT = 'wallets_ledger_tail';
        END IF;
        RETURN NULL;
      END;
      $$;`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallets_ledger_tail
        AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallets_check_ledger_tail();`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallet_ledger_entries_tail
        AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallets_check_ledger_tail();`);
  }

  override down(): void {
    this.addSql(
      "DROP TRIGGER wallet_ledger_entries_tail ON wallet_ledger_entries;",
    );
    this.addSql("DROP TRIGGER wallets_ledger_tail ON wallets;");
    this.addSql("DROP FUNCTION wallets_check_ledger_tail();");
  }
}

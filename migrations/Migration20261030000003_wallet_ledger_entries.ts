import { Migration } from "@mikro-orm/migrations";

/**
 * Ledger append-only (R-05-05, R-06-40, R-06-41, D6.8, D7.3, D15.4, D15.6, D15.7).
 * A app só lê e insere; o trigger bloqueia UPDATE/DELETE/TRUNCATE até
 * para o dono. O UNIQUE (wallet_id, wallet_version) é a segunda camada da
 * D7.2: dois escritores sem lock geram a mesma versão e um é recusado.
 */
export class Migration20261030000003_wallet_ledger_entries extends Migration {
  override name = "Migration20261030000003_wallet_ledger_entries";

  override up(): void {
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id              uuid          NOT NULL,
        wallet_id       uuid          NOT NULL,
        transaction_id  uuid          NOT NULL,
        direction       varchar(6)    NOT NULL,
        amount          numeric(20,2) NOT NULL,
        currency        char(3)       NOT NULL,
        balance_before  numeric(20,2) NOT NULL,
        balance_after   numeric(20,2) NOT NULL,
        wallet_version  integer       NOT NULL,
        created_at      timestamptz   NOT NULL,

        CONSTRAINT wallet_ledger_entries_pk PRIMARY KEY (id),
        CONSTRAINT wallet_ledger_entries_transaction_uq UNIQUE (transaction_id),
        CONSTRAINT wallet_ledger_entries_wallet_version_uq UNIQUE (wallet_id, wallet_version),
        CONSTRAINT wallet_ledger_entries_wallet_currency_fk
          FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
        CONSTRAINT wallet_ledger_entries_transaction_fk
          FOREIGN KEY (transaction_id, wallet_id, currency)
          REFERENCES wager_transactions (id, wallet_id, currency),

        CONSTRAINT wallet_ledger_entries_direction_ck CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT wallet_ledger_entries_amount_positive_ck CHECK (amount > 0),
        CONSTRAINT wallet_ledger_entries_balances_non_negative_ck
          CHECK (balance_before >= 0 AND balance_after >= 0),
        CONSTRAINT wallet_ledger_entries_arithmetic_ck CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount)
          OR (direction = 'DEBIT' AND balance_after = balance_before - amount)),
        CONSTRAINT wallet_ledger_entries_version_ck CHECK (wallet_version >= 1)
      );`);

    // Append-only (R-05-05): vale para qualquer papel, inclusive o dono.
    this.addSql(`
      CREATE FUNCTION wallet_ledger_entries_append_only() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'o ledger é append-only: % recusado', TG_OP
          USING ERRCODE = 'integrity_constraint_violation',
                CONSTRAINT = 'wallet_ledger_entries_append_only';
      END;
      $$;`);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_append_only
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entries_append_only();`);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_no_truncate
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION wallet_ledger_entries_append_only();`);

    // Encadeamento (D7.3): cada lançamento continua o anterior da wallet.
    // O primeiro parte de zero, com a versão 1 se for a OPENING e 2 se não
    // houver OPENING (D6.2, D15.6).
    this.addSql(`
      CREATE FUNCTION wallet_ledger_entries_chain() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        previous wallet_ledger_entries%ROWTYPE;
        transaction_kind text;
        expected_version integer;
        expected_before numeric(20,2);
      BEGIN
        SELECT * INTO previous FROM wallet_ledger_entries
         WHERE wallet_id = NEW.wallet_id
         ORDER BY wallet_version DESC LIMIT 1;
        SELECT kind INTO transaction_kind FROM wager_transactions
         WHERE id = NEW.transaction_id;

        IF previous.id IS NULL THEN
          expected_before := 0;
          expected_version := CASE WHEN transaction_kind = 'OPENING' THEN 1 ELSE 2 END;
        ELSIF transaction_kind = 'OPENING' THEN
          RAISE EXCEPTION 'a OPENING só pode ser o primeiro lançamento da wallet %', NEW.wallet_id
            USING ERRCODE = 'integrity_constraint_violation',
                  CONSTRAINT = 'wallet_ledger_entries_chain';
        ELSE
          expected_before := previous.balance_after;
          expected_version := previous.wallet_version + 1;
        END IF;

        IF NEW.wallet_version <> expected_version OR NEW.balance_before <> expected_before THEN
          RAISE EXCEPTION 'lançamento fora da cadeia da wallet %: esperado versão % com saldo anterior %',
                NEW.wallet_id, expected_version, expected_before
            USING ERRCODE = 'integrity_constraint_violation',
                  CONSTRAINT = 'wallet_ledger_entries_chain';
        END IF;
        RETURN NEW;
      END;
      $$;`);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_chain
        BEFORE INSERT ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entries_chain();`);

    this.addSql(
      "GRANT SELECT, INSERT ON wallet_ledger_entries TO wagering_app;",
    );
  }

  override down(): void {
    this.addSql("DROP TABLE wallet_ledger_entries;");
    this.addSql("DROP FUNCTION wallet_ledger_entries_chain();");
    this.addSql("DROP FUNCTION wallet_ledger_entries_append_only();");
  }
}

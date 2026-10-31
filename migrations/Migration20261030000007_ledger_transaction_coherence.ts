import { Migration } from "@mikro-orm/migrations";

/**
 * Coerência lançamento × transação (R-06-24, R-06-43, R-05-09, D15.9) e
 * nascimento do FAILED (D4.2, D15.5). Os dois constraint triggers são
 * diferidos e releem a linha no commit, porque o use case (e o worker)
 * gravam transação, lançamento e status em comandos separados:
 *   - todo lançamento aponta para uma transação PROCESSED que não é LOSS,
 *     com a direção do kind (a mesma wallet já vem da FK da D15.4);
 *   - toda transação PROCESSED que não é LOSS tem um lançamento (no
 *     máximo um já vem do UNIQUE (transaction_id)).
 * Daí, LOSS, REJECTED, PENDING_REFERENCE e FAILED não têm lançamento.
 */
export class Migration20261030000007_ledger_transaction_coherence extends Migration {
  override name = "Migration20261030000007_ledger_transaction_coherence";

  override up(): void {
    // Direção do lançamento por kind; ROLLBACK é o inverso da referência.
    this.addSql(`
      CREATE FUNCTION wager_transactions_ledger_direction(target uuid) RETURNS text
      LANGUAGE plpgsql STABLE AS $$
      DECLARE
        tx wager_transactions%ROWTYPE;
        reference_direction text;
      BEGIN
        SELECT * INTO tx FROM wager_transactions WHERE id = target;
        IF tx.kind = 'BET' THEN
          RETURN 'DEBIT';
        ELSIF tx.kind IN ('WIN', 'REFUND', 'OPENING') THEN
          RETURN 'CREDIT';
        ELSIF tx.kind = 'ROLLBACK' THEN
          reference_direction := wager_transactions_ledger_direction(tx.reference_transaction_id);
          IF reference_direction = 'DEBIT' THEN
            RETURN 'CREDIT';
          ELSIF reference_direction = 'CREDIT' THEN
            RETURN 'DEBIT';
          END IF;
        END IF;
        RETURN NULL;
      END;
      $$;`);

    this.addSql(`
      CREATE FUNCTION wallet_ledger_entries_check_transaction() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        tx wager_transactions%ROWTYPE;
      BEGIN
        SELECT * INTO tx FROM wager_transactions WHERE id = NEW.transaction_id;
        IF tx.status IS DISTINCT FROM 'PROCESSED' OR tx.kind = 'LOSS' THEN
          RAISE EXCEPTION 'lançamento % aponta para transação % sem efeito no saldo (% %)',
                NEW.id, NEW.transaction_id, tx.kind, tx.status
            USING ERRCODE = 'integrity_constraint_violation',
                  CONSTRAINT = 'wallet_ledger_entries_transaction_processed';
        END IF;
        IF NEW.direction IS DISTINCT FROM wager_transactions_ledger_direction(tx.id) THEN
          RAISE EXCEPTION 'lançamento % tem direção % incompatível com o kind % da transação %',
                NEW.id, NEW.direction, tx.kind, tx.id
            USING ERRCODE = 'integrity_constraint_violation',
                  CONSTRAINT = 'wallet_ledger_entries_direction_by_kind';
        END IF;
        RETURN NULL;
      END;
      $$;`);
    // Nome depois de wallet_ledger_entries_tail: no mesmo evento, os
    // triggers disparam em ordem alfabética, e a cauda continua primeiro.
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallet_ledger_entries_transaction_match
        AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entries_check_transaction();`);

    this.addSql(`
      CREATE FUNCTION wager_transactions_check_ledger_entry() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        tx wager_transactions%ROWTYPE;
      BEGIN
        -- Relê: num UPDATE, o NEW do evento pode ser anterior ao estado final.
        SELECT * INTO tx FROM wager_transactions WHERE id = NEW.id;
        IF tx.status = 'PROCESSED' AND tx.kind <> 'LOSS'
           AND NOT EXISTS (SELECT 1 FROM wallet_ledger_entries WHERE transaction_id = tx.id) THEN
          RAISE EXCEPTION 'transação % (% PROCESSED) sem lançamento no commit', tx.id, tx.kind
            USING ERRCODE = 'integrity_constraint_violation',
                  CONSTRAINT = 'wager_transactions_ledger_entry_required';
        END IF;
        RETURN NULL;
      END;
      $$;`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wager_transactions_ledger_entry
        AFTER INSERT OR UPDATE ON wager_transactions
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wager_transactions_check_ledger_entry();`);

    // FAILED só nasce por UPDATE a partir de PENDING_REFERENCE (D4.2, D15.5).
    // Os outros status inválidos ficam com o wager_transactions_status_ck.
    this.addSql(`
      CREATE FUNCTION wager_transactions_guard_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status = 'FAILED' THEN
          RAISE EXCEPTION 'transação % não nasce FAILED: só uma PENDING_REFERENCE vira FAILED', NEW.id
            USING ERRCODE = 'integrity_constraint_violation',
                  CONSTRAINT = 'wager_transactions_insert_status';
        END IF;
        RETURN NEW;
      END;
      $$;`);
    this.addSql(`
      CREATE TRIGGER wager_transactions_guard_insert
        BEFORE INSERT ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wager_transactions_guard_insert();`);
  }

  override down(): void {
    this.addSql(
      "DROP TRIGGER wager_transactions_guard_insert ON wager_transactions;",
    );
    this.addSql("DROP FUNCTION wager_transactions_guard_insert();");
    this.addSql(
      "DROP TRIGGER wager_transactions_ledger_entry ON wager_transactions;",
    );
    this.addSql("DROP FUNCTION wager_transactions_check_ledger_entry();");
    this.addSql(
      "DROP TRIGGER wallet_ledger_entries_transaction_match ON wallet_ledger_entries;",
    );
    this.addSql("DROP FUNCTION wallet_ledger_entries_check_transaction();");
    this.addSql("DROP FUNCTION wager_transactions_ledger_direction(uuid);");
  }
}

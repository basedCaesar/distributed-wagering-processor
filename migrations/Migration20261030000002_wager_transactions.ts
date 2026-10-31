import { Migration } from "@mikro-orm/migrations";

/**
 * Transações (R-06-28..39, D1.1, D1.5, D3.1, D3.2, D6.1, D7.3, D14, D15.3, D15.5).
 * A `OPENING` fica aqui, com as colunas do provedor nulas (D6.1, D14.5).
 * O saldo observado (`balance_after`) é da wallet, então tem a moeda da
 * wallet, que pode diferir da transação no CURRENCY_MISMATCH (D3.5).
 */
export class Migration20261030000002_wager_transactions extends Migration {
  override name = "Migration20261030000002_wager_transactions";

  override up(): void {
    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                uuid          NOT NULL,
        provider_id                       text,
        external_transaction_id           text,
        idempotency_key                   varchar(255),
        payload_hash                      char(64),
        wallet_id                         uuid          NOT NULL,
        player_id                         varchar(128)  NOT NULL,
        round_id                          text,
        game_id                           text,
        kind                              varchar(16)   NOT NULL,
        amount                            numeric(20,2) NOT NULL,
        currency                          char(3)       NOT NULL,
        reference_external_transaction_id text,
        reference_transaction_id          uuid,
        status                            varchar(24)   NOT NULL,
        failure_code                      varchar(48),
        failure_detail                    varchar(16),
        balance_after                     numeric(20,2),
        balance_after_currency            char(3),
        processed_at                      timestamptz,
        created_at                        timestamptz   NOT NULL,
        updated_at                        timestamptz   NOT NULL,
        -- controle do worker, fora da entidade (D4.3, D4.5) e rastreio (D9.5)
        correlation_id                    text,
        attempts                          integer       NOT NULL DEFAULT 0,
        next_attempt_at                   timestamptz,
        locked_until                      timestamptz,

        CONSTRAINT wager_transactions_pk PRIMARY KEY (id),
        CONSTRAINT wager_transactions_wallet_fk
          FOREIGN KEY (wallet_id) REFERENCES wallets (id),
        CONSTRAINT wager_transactions_balance_currency_fk
          FOREIGN KEY (wallet_id, balance_after_currency) REFERENCES wallets (id, currency),

        -- unicidade (D3.1, D3.2); nulos da OPENING ficam fora naturalmente (D6.1)
        CONSTRAINT wager_transactions_provider_key_uq UNIQUE (provider_id, idempotency_key),
        CONSTRAINT wager_transactions_provider_external_uq UNIQUE (provider_id, external_transaction_id),
        -- alvos das FKs compostas: referência (D7.3) e ledger (D15.4)
        CONSTRAINT wager_transactions_reference_target_uq UNIQUE (id, wallet_id, currency, round_id),
        CONSTRAINT wager_transactions_ledger_target_uq UNIQUE (id, wallet_id, currency),

        -- a referência é da mesma wallet, moeda e rodada (D7.3)
        CONSTRAINT wager_transactions_reference_scope_fk
          FOREIGN KEY (reference_transaction_id, wallet_id, currency, round_id)
          REFERENCES wager_transactions (id, wallet_id, currency, round_id),

        -- domínios
        CONSTRAINT wager_transactions_kind_ck
          CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        CONSTRAINT wager_transactions_status_ck
          CHECK (status IN ('PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        CONSTRAINT wager_transactions_failure_code_ck
          CHECK (failure_code IN (
            'INSUFFICIENT_FUNDS', 'INSUFFICIENT_FUNDS_FOR_REVERSAL', 'CURRENCY_MISMATCH',
            'WALLET_PLAYER_MISMATCH', 'REFERENCE_NOT_FOUND', 'REFERENCE_SCOPE_MISMATCH',
            'REFERENCE_KIND_NOT_ALLOWED', 'REFERENCE_NOT_PROCESSED', 'REFERENCE_ALREADY_REVERSED',
            'AMOUNT_MISMATCH', 'BALANCE_LIMIT_EXCEEDED', 'PROCESSING_FAILED')),
        CONSTRAINT wager_transactions_failure_detail_values_ck
          CHECK (failure_detail IN ('PLAYER', 'WALLET', 'CURRENCY', 'ROUND')),
        CONSTRAINT wager_transactions_currency_format_ck CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wager_transactions_payload_hash_ck CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT wager_transactions_attempts_ck CHECK (attempts >= 0),

        -- não-negatividade (D2.3, D7.3)
        CONSTRAINT wager_transactions_amount_ck
          CHECK (amount > 0 OR (kind = 'LOSS' AND amount = 0)),
        CONSTRAINT wager_transactions_balance_after_non_negative_ck CHECK (balance_after >= 0),
        CONSTRAINT wager_transactions_balance_after_pair_ck
          CHECK ((balance_after IS NULL) = (balance_after_currency IS NULL)),

        -- colunas do provedor: nulas na OPENING, preenchidas nos outros kinds (D6.1, D14.5)
        CONSTRAINT wager_transactions_provider_columns_ck CHECK (
          CASE WHEN kind = 'OPENING' THEN
            provider_id IS NULL AND external_transaction_id IS NULL AND idempotency_key IS NULL
            AND payload_hash IS NULL AND round_id IS NULL AND game_id IS NULL
          ELSE
            provider_id IS NOT NULL AND external_transaction_id IS NOT NULL AND idempotency_key IS NOT NULL
            AND payload_hash IS NOT NULL AND round_id IS NOT NULL AND game_id IS NOT NULL
          END),

        -- referência por kind: obrigatória em REFUND/ROLLBACK, proibida em BET/OPENING (D1.5)
        CONSTRAINT wager_transactions_reference_by_kind_ck CHECK (
          CASE
            WHEN kind IN ('REFUND', 'ROLLBACK') THEN reference_external_transaction_id IS NOT NULL
            WHEN kind IN ('BET', 'OPENING') THEN reference_external_transaction_id IS NULL
            ELSE TRUE
          END),

        -- coerência por status (D15.3)
        CONSTRAINT wager_transactions_processed_ck CHECK (
          status <> 'PROCESSED' OR (
            processed_at IS NOT NULL AND balance_after IS NOT NULL AND failure_code IS NULL
            AND (reference_external_transaction_id IS NULL) = (reference_transaction_id IS NULL))),
        CONSTRAINT wager_transactions_rejected_ck CHECK (
          status <> 'REJECTED' OR (
            failure_code IS NOT NULL AND failure_code <> 'PROCESSING_FAILED'
            AND balance_after IS NOT NULL AND processed_at IS NULL)),
        CONSTRAINT wager_transactions_failed_ck CHECK (
          status <> 'FAILED' OR (
            failure_code = 'PROCESSING_FAILED' AND balance_after IS NULL AND processed_at IS NULL)),
        CONSTRAINT wager_transactions_pending_reference_ck CHECK (
          status <> 'PENDING_REFERENCE' OR (
            reference_external_transaction_id IS NOT NULL AND failure_code IS NULL
            AND balance_after IS NULL AND processed_at IS NULL)),
        CONSTRAINT wager_transactions_failure_detail_ck CHECK (
          (failure_detail IS NOT NULL) = (failure_code IS NOT DISTINCT FROM 'REFERENCE_SCOPE_MISMATCH')),
        -- id interno da referência só quando ela foi validada, ou seja, no PROCESSED (D7.3, D14.6)
        CONSTRAINT wager_transactions_reference_id_ck CHECK (
          reference_transaction_id IS NULL OR status = 'PROCESSED')
      );`);

    // Uma OPENING por wallet (D6.1)
    this.addSql(`
      CREATE UNIQUE INDEX wager_transactions_one_opening_uq
        ON wager_transactions (wallet_id) WHERE kind = 'OPENING';`);

    // Uma reversão PROCESSED por referência, de qualquer tipo (D1.1)
    this.addSql(`
      CREATE UNIQUE INDEX wager_transactions_one_processed_reversal_uq
        ON wager_transactions (reference_transaction_id)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK');`);

    // Pendentes: claim do worker (D4.3) e "cutucada" da mesma wallet (D4.4)
    this.addSql(`
      CREATE INDEX wager_transactions_pending_due_ix
        ON wager_transactions (next_attempt_at) WHERE status = 'PENDING_REFERENCE';`);
    this.addSql(`
      CREATE INDEX wager_transactions_pending_by_reference_ix
        ON wager_transactions (wallet_id, provider_id, reference_external_transaction_id)
        WHERE status = 'PENDING_REFERENCE';`);

    // Imutabilidade (D7.3) e transições (D4.5, D15.5): terminal não muda;
    // as colunas da submissão nunca mudam. Só PENDING_REFERENCE é gravado
    // fora dos terminais (status_ck), então o único caminho é
    // PENDING_REFERENCE → PROCESSED | REJECTED | FAILED (ou ficar, ao mexer
    // só nas colunas de controle).
    this.addSql(`
      CREATE FUNCTION wager_transactions_guard_update() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
          RAISE EXCEPTION 'transação % é terminal (%) e não muda', OLD.id, OLD.status
            USING ERRCODE = 'integrity_constraint_violation',
                  CONSTRAINT = 'wager_transactions_terminal_immutable';
        END IF;
        IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key,
            NEW.payload_hash, NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id,
            NEW.kind, NEW.amount, NEW.currency, NEW.reference_external_transaction_id,
            NEW.created_at, NEW.correlation_id)
           IS DISTINCT FROM
           (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key,
            OLD.payload_hash, OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id,
            OLD.kind, OLD.amount, OLD.currency, OLD.reference_external_transaction_id,
            OLD.created_at, OLD.correlation_id) THEN
          RAISE EXCEPTION 'colunas imutáveis da transação % alteradas', OLD.id
            USING ERRCODE = 'integrity_constraint_violation',
                  CONSTRAINT = 'wager_transactions_immutable_columns';
        END IF;
        RETURN NEW;
      END;
      $$;`);
    this.addSql(`
      CREATE TRIGGER wager_transactions_guard_update
        BEFORE UPDATE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wager_transactions_guard_update();`);

    this.addSql(
      "GRANT SELECT, INSERT, UPDATE ON wager_transactions TO wagering_app;",
    );
  }

  override down(): void {
    this.addSql("DROP TABLE wager_transactions;");
    this.addSql("DROP FUNCTION wager_transactions_guard_update();");
  }
}

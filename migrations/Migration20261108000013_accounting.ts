import { Migration } from "@mikro-orm/migrations";

const APPEND_ONLY_TABLES = ["accounts", "received_events", "journal_entries", "journal_lines"] as const;

/**
 * Partidas dobradas (S14, D27.3): o schema `accounting`, do contexto de
 * mesmo nome, no mesmo Postgres. Nada do núcleo muda.
 * - `accounts`: o plano de contas (D27.2), uma `PLAYER_WALLET` por wallet;
 * - `received_events`: as metades `WalletBalanceChanged` e
 *   `WagerTransactionProcessed` (D27.1);
 * - `journal_entries` e `journal_lines`: o diário; débito = crédito no
 *   COMMIT (constraint triggers diferidos);
 * - `inbox_messages` e `message_attempts`: os do consumidor (D27.5).
 * As quatro primeiras são append-only até para o dono. O `accounting_app`
 * (criado no `postgres-init.sh`, D27.9) só lê e insere; o `wagering_app`
 * não tem nada aqui.
 */
export class Migration20261108000013_accounting extends Migration {
  override name = "Migration20261108000013_accounting";

  override up(): void {
    this.addSql(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accounting_app') THEN
          RAISE EXCEPTION 'o papel accounting_app não existe: recrie o volume do Postgres para o postgres-init.sh rodar (D27.9)';
        END IF;
      END;
      $$;`);
    this.addSql("CREATE SCHEMA accounting;");
    this.addSql("REVOKE ALL ON SCHEMA accounting FROM PUBLIC;");
    this.addSql("GRANT USAGE ON SCHEMA accounting TO accounting_app;");

    this.addSql(`
      CREATE TABLE accounting.accounts (
        id          uuid         NOT NULL,
        code        text         NOT NULL,
        nature      text         NOT NULL,
        currency    char(3)      NOT NULL,
        wallet_id   uuid,
        created_at  timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT accounts_pk PRIMARY KEY (id),
        CONSTRAINT accounts_id_currency_uq UNIQUE (id, currency),
        CONSTRAINT accounts_wallet_uq UNIQUE (wallet_id),
        CONSTRAINT accounts_nature_ck CHECK ((code, nature) IN (
          ('PLAYER_WALLET', 'LIABILITY'),
          ('HOUSE_OPENING_FUNDS', 'ASSET'),
          ('HOUSE_WAGERS_RECEIVED', 'REVENUE'),
          ('HOUSE_PAYOUTS', 'EXPENSE'),
          ('HOUSE_REFUNDS', 'CONTRA_REVENUE'),
          ('HOUSE_ROLLBACKS', 'ADJUSTMENT'))),
        CONSTRAINT accounts_wallet_ck CHECK ((code = 'PLAYER_WALLET') = (wallet_id IS NOT NULL)),
        CONSTRAINT accounts_currency_ck CHECK (currency ~ '^[A-Z]{3}$')
      );`);
    // Uma conta da casa por código e moeda.
    this.addSql(`
      CREATE UNIQUE INDEX accounts_house_uq
        ON accounting.accounts (code, currency) WHERE wallet_id IS NULL;`);

    this.addSql(`
      CREATE TABLE accounting.received_events (
        event_id        uuid           NOT NULL,
        event_type      text           NOT NULL,
        transaction_id  uuid           NOT NULL,
        wallet_id       uuid           NOT NULL,
        wallet_version  integer        NOT NULL,
        currency        char(3)        NOT NULL,
        amount          numeric(20,2)  NOT NULL,
        kind            text,
        direction       varchar(6),
        balance_before  numeric(20,2),
        balance_after   numeric(20,2)  NOT NULL,
        occurred_at     timestamptz    NOT NULL,
        received_at     timestamptz    NOT NULL,
        CONSTRAINT received_events_pk PRIMARY KEY (event_id),
        CONSTRAINT received_events_transaction_type_uq UNIQUE (transaction_id, event_type),
        CONSTRAINT received_events_shape_ck CHECK (
          (event_type = 'WalletBalanceChanged' AND kind IS NULL
             AND direction IN ('DEBIT', 'CREDIT') AND balance_before IS NOT NULL)
          OR (event_type = 'WagerTransactionProcessed' AND kind IS NOT NULL
             AND direction IS NULL AND balance_before IS NULL)),
        CONSTRAINT received_events_amount_positive_ck CHECK (amount > 0),
        CONSTRAINT received_events_version_ck CHECK (wallet_version >= 1)
      );`);
    this.addSql(`
      CREATE INDEX received_events_wallet_ix
        ON accounting.received_events (wallet_id, wallet_version);`);

    this.addSql(`
      CREATE TABLE accounting.journal_entries (
        id                  uuid         NOT NULL,
        transaction_id      uuid         NOT NULL,
        wallet_id           uuid         NOT NULL,
        wallet_version      integer      NOT NULL,
        kind                text         NOT NULL,
        currency            char(3)      NOT NULL,
        balance_event_id    uuid         NOT NULL,
        processed_event_id  uuid         NOT NULL,
        occurred_at         timestamptz  NOT NULL,
        posted_at           timestamptz  NOT NULL,
        CONSTRAINT journal_entries_pk PRIMARY KEY (id),
        CONSTRAINT journal_entries_id_currency_uq UNIQUE (id, currency),
        CONSTRAINT journal_entries_transaction_uq UNIQUE (transaction_id),
        CONSTRAINT journal_entries_wallet_version_uq UNIQUE (wallet_id, wallet_version),
        CONSTRAINT journal_entries_balance_event_uq UNIQUE (balance_event_id),
        CONSTRAINT journal_entries_processed_event_uq UNIQUE (processed_event_id),
        CONSTRAINT journal_entries_balance_event_fk
          FOREIGN KEY (balance_event_id) REFERENCES accounting.received_events (event_id),
        CONSTRAINT journal_entries_processed_event_fk
          FOREIGN KEY (processed_event_id) REFERENCES accounting.received_events (event_id),
        CONSTRAINT journal_entries_kind_ck CHECK (kind IN ('OPENING', 'BET', 'WIN', 'REFUND', 'ROLLBACK')),
        CONSTRAINT journal_entries_version_ck CHECK (wallet_version >= 1)
      );`);

    this.addSql(`
      CREATE TABLE accounting.journal_lines (
        entry_id    uuid           NOT NULL,
        line_no     smallint       NOT NULL,
        account_id  uuid           NOT NULL,
        direction   varchar(6)     NOT NULL,
        amount      numeric(20,2)  NOT NULL,
        currency    char(3)        NOT NULL,
        CONSTRAINT journal_lines_pk PRIMARY KEY (entry_id, line_no),
        CONSTRAINT journal_lines_entry_currency_fk
          FOREIGN KEY (entry_id, currency) REFERENCES accounting.journal_entries (id, currency),
        CONSTRAINT journal_lines_account_currency_fk
          FOREIGN KEY (account_id, currency) REFERENCES accounting.accounts (id, currency),
        CONSTRAINT journal_lines_direction_ck CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT journal_lines_amount_positive_ck CHECK (amount > 0),
        CONSTRAINT journal_lines_line_no_ck CHECK (line_no >= 1)
      );`);
    this.addSql("CREATE INDEX journal_lines_account_ix ON accounting.journal_lines (account_id);");

    this.addSql(`
      CREATE TABLE accounting.inbox_messages (
        consumer_name  text         NOT NULL,
        message_id     text         NOT NULL,
        payload_hash   char(64)     NOT NULL,
        processed_at   timestamptz  NOT NULL,
        CONSTRAINT accounting_inbox_messages_pk PRIMARY KEY (consumer_name, message_id)
      );`);
    this.addSql(`
      CREATE TABLE accounting.message_attempts (
        consumer_name     text         NOT NULL,
        message_id        text         NOT NULL,
        attempts          integer      NOT NULL,
        last_error_code   text,
        first_attempt_at  timestamptz  NOT NULL,
        last_attempt_at   timestamptz  NOT NULL,
        CONSTRAINT accounting_message_attempts_pk PRIMARY KEY (consumer_name, message_id),
        CONSTRAINT accounting_message_attempts_ck CHECK (attempts >= 1)
      );`);

    // Débito = crédito, ≥ 2 linhas e exatamente uma linha da conta da wallet
    // do lançamento (D27.3). Diferido: as linhas entram depois do lançamento
    // na mesma transação, e o par é conferido no COMMIT.
    this.addSql(`
      CREATE FUNCTION accounting.journal_entry_check(target uuid) RETURNS void
      LANGUAGE plpgsql AS $$
      DECLARE
        entry_wallet uuid;
        line_count integer;
        debits numeric;
        credits numeric;
        player_lines integer;
      BEGIN
        SELECT wallet_id INTO entry_wallet FROM accounting.journal_entries WHERE id = target;
        IF entry_wallet IS NULL THEN
          RETURN;
        END IF;
        SELECT count(*),
               COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'DEBIT'), 0),
               COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'CREDIT'), 0),
               count(*) FILTER (WHERE a.code = 'PLAYER_WALLET' AND a.wallet_id = entry_wallet)
          INTO line_count, debits, credits, player_lines
          FROM accounting.journal_lines l
          JOIN accounting.accounts a ON a.id = l.account_id
         WHERE l.entry_id = target;
        IF line_count < 2 OR debits <> credits THEN
          RAISE EXCEPTION 'lançamento % desbalanceado ou com menos de 2 linhas', target
            USING ERRCODE = 'integrity_constraint_violation',
                  CONSTRAINT = 'journal_entries_balanced';
        END IF;
        IF player_lines <> 1 THEN
          RAISE EXCEPTION 'lançamento % sem exatamente uma linha da conta da wallet', target
            USING ERRCODE = 'integrity_constraint_violation',
                  CONSTRAINT = 'journal_entries_player_line';
        END IF;
      END;
      $$;`);
    this.addSql(`
      CREATE FUNCTION accounting.journal_entries_balanced() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM accounting.journal_entry_check(NEW.id);
        RETURN NULL;
      END;
      $$;`);
    this.addSql(`
      CREATE FUNCTION accounting.journal_lines_balanced() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM accounting.journal_entry_check(NEW.entry_id);
        RETURN NULL;
      END;
      $$;`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER journal_entries_balanced
        AFTER INSERT ON accounting.journal_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION accounting.journal_entries_balanced();`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER journal_lines_balanced
        AFTER INSERT ON accounting.journal_lines
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION accounting.journal_lines_balanced();`);

    // Append-only (D27.3): vale para qualquer papel, inclusive o dono.
    this.addSql(`
      CREATE FUNCTION accounting.append_only() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'accounting.% é append-only: % recusado', TG_TABLE_NAME, TG_OP
          USING ERRCODE = 'integrity_constraint_violation',
                CONSTRAINT = TG_TABLE_NAME || '_append_only';
      END;
      $$;`);
    for (const table of APPEND_ONLY_TABLES) {
      this.addSql(`
        CREATE TRIGGER ${table}_append_only
          BEFORE UPDATE OR DELETE ON accounting.${table}
          FOR EACH ROW EXECUTE FUNCTION accounting.append_only();`);
      this.addSql(`
        CREATE TRIGGER ${table}_no_truncate
          BEFORE TRUNCATE ON accounting.${table}
          FOR EACH STATEMENT EXECUTE FUNCTION accounting.append_only();`);
      this.addSql(`GRANT SELECT, INSERT ON accounting.${table} TO accounting_app;`);
    }
    // O `SELECT … FOR UPDATE` da conta da wallet (lock 2, D27.4) exige UPDATE
    // em pelo menos uma coluna. Só no `id`: nenhuma outra coluna pode ser
    // alterada nem pelo privilégio, e o trigger append-only recusa até essa.
    this.addSql("GRANT UPDATE (id) ON accounting.accounts TO accounting_app;");
    this.addSql("GRANT SELECT, INSERT ON accounting.inbox_messages TO accounting_app;");
    // Upsert das tentativas e a limpeza da D19.11.
    this.addSql("GRANT SELECT, INSERT, UPDATE, DELETE ON accounting.message_attempts TO accounting_app;");
  }

  override down(): void {
    this.addSql("DROP SCHEMA accounting CASCADE;");
  }
}

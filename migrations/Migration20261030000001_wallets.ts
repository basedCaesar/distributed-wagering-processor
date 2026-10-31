import { Migration } from "@mikro-orm/migrations";

/**
 * Wallets (R-06-22..27, D2.4, D7.3, D15.2).
 * O papel da app só altera saldo, versão e updated_at; nunca apaga.
 */
export class Migration20261030000001_wallets extends Migration {
  override name = "Migration20261030000001_wallets";

  override up(): void {
    this.addSql("GRANT USAGE ON SCHEMA public TO wagering_app;");

    this.addSql(`
      CREATE TABLE wallets (
        id          uuid           NOT NULL,
        player_id   varchar(128)   NOT NULL,
        currency    char(3)        NOT NULL,
        balance     numeric(20,2)  NOT NULL,
        version     integer        NOT NULL,
        created_at  timestamptz    NOT NULL,
        updated_at  timestamptz    NOT NULL,
        CONSTRAINT wallets_pk PRIMARY KEY (id),
        CONSTRAINT wallets_player_currency_uq UNIQUE (player_id, currency),
        -- alvo das FKs (id, currency) do ledger e do saldo das transações (D15.4)
        CONSTRAINT wallets_id_currency_uq UNIQUE (id, currency),
        CONSTRAINT wallets_currency_format_ck CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wallets_balance_non_negative_ck CHECK (balance >= 0),
        CONSTRAINT wallets_balance_limit_ck CHECK (balance < 1000000000000000),
        CONSTRAINT wallets_version_ck CHECK (version >= 1)
      );`);

    this.addSql("GRANT SELECT, INSERT ON wallets TO wagering_app;");
    this.addSql(
      "GRANT UPDATE (balance, version, updated_at) ON wallets TO wagering_app;",
    );
  }

  override down(): void {
    this.addSql("DROP TABLE wallets;");
    this.addSql("REVOKE USAGE ON SCHEMA public FROM wagering_app;");
  }
}

import { Migration } from "@mikro-orm/migrations";

/**
 * Inbox (R-06-50, R-10-04, D3.7, D3.8), outbox (R-06-51, D9.2, D9.3, D9.6) e
 * tentativas do consumidor (D8.3). Nenhuma recebe DELETE.
 */
export class Migration20261030000005_messaging extends Migration {
  override name = "Migration20261030000005_messaging";

  override up(): void {
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name  text         NOT NULL,
        message_id     text         NOT NULL,
        payload_hash   char(64)     NOT NULL,
        received_at    timestamptz  NOT NULL,
        processed_at   timestamptz,
        CONSTRAINT inbox_messages_pk PRIMARY KEY (consumer_name, message_id)
      );`);
    this.addSql("GRANT SELECT, INSERT ON inbox_messages TO wagering_app;");
    this.addSql(
      "GRANT UPDATE (processed_at) ON inbox_messages TO wagering_app;",
    );

    // position: ordem de gravação; dentro de uma wallet, as linhas nascem
    // sob o lock dela, então a ordem de position é a ordem dos eventos (D9.2).
    this.addSql(`
      CREATE TABLE outbox_messages (
        id               uuid         NOT NULL,
        position         bigint       GENERATED ALWAYS AS IDENTITY,
        aggregate_id     uuid         NOT NULL,
        ordering_key     uuid         NOT NULL,
        event_type       text         NOT NULL,
        payload          jsonb        NOT NULL,
        occurred_at      timestamptz  NOT NULL,
        attempts         integer      NOT NULL DEFAULT 0,
        next_attempt_at  timestamptz  NOT NULL,
        locked_until     timestamptz,
        published_at     timestamptz,
        last_error_code  text,
        CONSTRAINT outbox_messages_pk PRIMARY KEY (id),
        CONSTRAINT outbox_messages_position_uq UNIQUE (position),
        CONSTRAINT outbox_messages_attempts_ck CHECK (attempts >= 0)
      );`);
    this.addSql(`
      CREATE INDEX outbox_messages_unpublished_ix
        ON outbox_messages (ordering_key, position) WHERE published_at IS NULL;`);
    this.addSql("GRANT SELECT, INSERT ON outbox_messages TO wagering_app;");
    this.addSql(`
      GRANT UPDATE (attempts, next_attempt_at, locked_until, published_at, last_error_code)
        ON outbox_messages TO wagering_app;`);

    this.addSql(`
      CREATE TABLE message_attempts (
        consumer_name     text         NOT NULL,
        message_id        text         NOT NULL,
        attempts          integer      NOT NULL,
        last_error_code   text,
        first_attempt_at  timestamptz  NOT NULL,
        last_attempt_at   timestamptz  NOT NULL,
        CONSTRAINT message_attempts_pk PRIMARY KEY (consumer_name, message_id),
        CONSTRAINT message_attempts_attempts_ck CHECK (attempts >= 1)
      );`);
    this.addSql(
      "GRANT SELECT, INSERT, UPDATE ON message_attempts TO wagering_app;",
    );
  }

  override down(): void {
    this.addSql("DROP TABLE message_attempts;");
    this.addSql("DROP TABLE outbox_messages;");
    this.addSql("DROP TABLE inbox_messages;");
  }
}

import { Migration } from "@mikro-orm/migrations";

/**
 * Publisher da outbox e auditor dos eventos (S7):
 * - `outbox_messages.locked_by`: o dono do lease (D20.5). Marcar como
 *   publicado ou gravar a falha só vale para ele;
 * - `audited_events`: o efeito do `event-auditor` (D9.7, D20.1). Só
 *   `INSERT` para a app; a ordem de chegada é `arrival`.
 */
export class Migration20261101000012_outbox_publisher_and_audit extends Migration {
  override name = "Migration20261101000012_outbox_publisher_and_audit";

  override up(): void {
    this.addSql("ALTER TABLE outbox_messages ADD COLUMN locked_by uuid;");
    this.addSql("GRANT UPDATE (locked_by) ON outbox_messages TO wagering_app;");

    this.addSql(`
      CREATE TABLE audited_events (
        event_id        uuid         NOT NULL,
        arrival         bigint       GENERATED ALWAYS AS IDENTITY,
        event_type      text         NOT NULL,
        aggregate_id    uuid         NOT NULL,
        wallet_id       uuid,
        wallet_version  integer,
        in_order        boolean,
        occurred_at     timestamptz  NOT NULL,
        audited_at      timestamptz  NOT NULL,
        CONSTRAINT audited_events_pk PRIMARY KEY (event_id),
        CONSTRAINT audited_events_arrival_uq UNIQUE (arrival),
        CONSTRAINT audited_events_version_ck CHECK (wallet_version IS NULL OR wallet_version >= 1),
        CONSTRAINT audited_events_version_wallet_ck CHECK (wallet_version IS NULL OR wallet_id IS NOT NULL),
        CONSTRAINT audited_events_in_order_ck CHECK ((in_order IS NULL) = (wallet_version IS NULL))
      );`);
    // A última versão auditada de uma wallet por tipo de evento (D20.1).
    this.addSql(`
      CREATE INDEX audited_events_wallet_type_ix
        ON audited_events (wallet_id, event_type, wallet_version)
        WHERE wallet_version IS NOT NULL;`);
    this.addSql("GRANT SELECT, INSERT ON audited_events TO wagering_app;");
  }

  override down(): void {
    this.addSql("DROP TABLE audited_events;");
    this.addSql("ALTER TABLE outbox_messages DROP COLUMN locked_by;");
  }
}

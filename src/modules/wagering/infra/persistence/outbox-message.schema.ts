import { EntitySchema } from "@mikro-orm/core";

/**
 * Linha de `outbox_messages` que o use case grava (D9.2, D9.3, D9.6).
 * `position` é `GENERATED ALWAYS` e as colunas do publisher (`locked_until`,
 * `published_at`, `last_error_code`) nascem nulas: ficam fora do record.
 */
export interface OutboxMessageRecord {
  id: string;
  aggregateId: string;
  orderingKey: string;
  eventType: string;
  payload: unknown;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  name: "OutboxMessageRecord",
  tableName: "outbox_messages",
  properties: {
    id: { type: "uuid", primary: true },
    aggregateId: { type: "uuid", fieldName: "aggregate_id" },
    orderingKey: { type: "uuid", fieldName: "ordering_key" },
    eventType: { type: "string", fieldName: "event_type" },
    payload: { type: "json", columnType: "jsonb" },
    occurredAt: {
      type: "datetime",
      fieldName: "occurred_at",
      columnType: "timestamptz",
    },
    attempts: { type: "integer" },
    nextAttemptAt: {
      type: "datetime",
      fieldName: "next_attempt_at",
      columnType: "timestamptz",
    },
  },
});

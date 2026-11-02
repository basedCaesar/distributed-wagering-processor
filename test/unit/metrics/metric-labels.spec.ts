import { describe, expect, it } from "bun:test";
import { METRIC_LABEL_VALUES, metricsRegistry } from "../../../src/shared/metrics/metrics";

/**
 * D22.11: labels só de conjuntos fechados, nunca ids. Percorre o registry
 * do processo inteiro: uma métrica nova com label fora da lista quebra aqui.
 */

/** Labels que carregariam ids ou dados pessoais (D11.1, D22.11). */
const FORBIDDEN = ["walletId", "transactionId", "providerId", "playerId", "messageId", "eventId", "correlationId"];

/** O `le` dos histogramas é do prom-client, não nosso. */
const PROM_INTERNAL = new Set(["le"]);

function labelNamesOf(metric: unknown): string[] {
  return [...((metric as { labelNames?: readonly string[] }).labelNames ?? [])];
}

describe("D22.11: labels das métricas", () => {
  it("D22.11: todo label de toda métrica do registry está na lista permitida", () => {
    const allowed = new Set(Object.keys(METRIC_LABEL_VALUES));
    const outside: string[] = [];

    for (const metric of metricsRegistry.getMetricsAsArray()) {
      for (const label of labelNamesOf(metric)) {
        if (!allowed.has(label) && !PROM_INTERNAL.has(label)) outside.push(`${metric.name}{${label}}`);
      }
    }

    expect(outside).toEqual([]);
  });

  it("D22.11: nenhum label permitido é um id (nem em snake_case)", () => {
    const normalized = (name: string) => name.replaceAll("_", "").toLowerCase();
    const forbidden = new Set(FORBIDDEN.map(normalized));

    for (const label of Object.keys(METRIC_LABEL_VALUES)) {
      expect(forbidden.has(normalized(label))).toBe(false);
    }
  });

  it("D22.11: cada label permitido tem um conjunto fechado e não vazio de valores", () => {
    for (const [label, values] of Object.entries(METRIC_LABEL_VALUES)) {
      expect({ label, size: values.length > 0 }).toEqual({ label, size: true });
    }
  });

  it("D11.2 D22.1–22.8: todas as métricas da D11.2 estão registradas", () => {
    const names = new Set(metricsRegistry.getMetricsAsArray().map((metric) => metric.name));

    for (const name of [
      "wagering_transactions_total",
      "wagering_duplicates_total",
      "wagering_retries_total",
      "wagering_dlq_messages_total",
      "sqs_dlq_depth",
      "wallet_lock_wait_seconds",
      "wallet_lock_conflicts_total",
      "outbox_pending_events",
      "outbox_lag_seconds",
      "wagering_processing_duration_seconds",
      "reconciliation_divergences_total",
      "wagering_refund_after_settlement_total",
      "outbox_events_stalled_total",
      "audited_events_out_of_order_total",
    ]) {
      expect({ name, registered: names.has(name) }).toEqual({ name, registered: true });
    }
  });
});

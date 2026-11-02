import { describe, expect, it } from "bun:test";
import { Counter, Registry } from "prom-client";
import { dlqReason, METRIC_LABEL_VALUES, metricsRegistry } from "../../../src/shared/metrics/metrics";
import { closedSetViolations, labelNameViolations } from "../../support/metrics";

/**
 * D22.11: labels só de conjuntos fechados, nunca ids, com a lista **de cada
 * métrica**. Percorre o registry do processo inteiro: uma métrica nova sem
 * lista, ou com label fora da lista dela, quebra aqui.
 */

/** Labels que carregariam ids ou dados pessoais (D11.1, D22.11). */
const FORBIDDEN = ["walletId", "transactionId", "providerId", "playerId", "messageId", "eventId", "correlationId"];

/** Um registry isolado com uma métrica de nome real, para provar o verificador. */
function registryWith(name: string, labels: Record<string, string>): Registry {
  const registry = new Registry();
  new Counter({ name, help: "teste", labelNames: Object.keys(labels), registers: [registry] }).inc(labels);
  return registry;
}

describe("D22.11: labels das métricas", () => {
  it("D22.11: toda métrica do registry tem lista própria, e os labels declarados são exatamente os da lista", () => {
    expect(labelNameViolations()).toEqual([]);
  });

  it("D22.11: nenhum label de nenhuma métrica é um id (nem em snake_case)", () => {
    const normalized = (name: string) => name.replaceAll("_", "").toLowerCase();
    const forbidden = new Set(FORBIDDEN.map(normalized));

    for (const [metric, labels] of Object.entries(METRIC_LABEL_VALUES)) {
      for (const label of Object.keys(labels)) {
        expect({ metric, label, id: forbidden.has(normalized(label)) }).toEqual({ metric, label, id: false });
      }
    }
  });

  it("D22.11: cada label de cada métrica tem um conjunto fechado e não vazio de valores", () => {
    for (const [metric, labels] of Object.entries(METRIC_LABEL_VALUES)) {
      for (const [label, values] of Object.entries(labels as Record<string, readonly string[]>)) {
        expect({ metric, label, size: values.length > 0 }).toEqual({ metric, label, size: true });
      }
    }
  });

  it("D22.11: o valor é conferido contra a lista da métrica: wallet_lock_conflicts_total{reason=\"NOT_FOUND\"} falha, mesmo sendo um reason válido da DLQ", async () => {
    const violations = await closedSetViolations(registryWith("wallet_lock_conflicts_total", { reason: "NOT_FOUND" }));

    expect(violations).toEqual(['wallet_lock_conflicts_total{reason="NOT_FOUND"}']);
  });

  it("D22.11: o inverso também falha: wagering_dlq_messages_total{reason=\"deadlock\"}", async () => {
    const violations = await closedSetViolations(
      registryWith("wagering_dlq_messages_total", { consumer: "wager_transactions", reason: "deadlock" }),
    );

    expect(violations).toEqual(['wagering_dlq_messages_total{reason="deadlock"}']);
  });

  it("D22.11: um valor da lista da métrica passa", async () => {
    expect(await closedSetViolations(registryWith("wallet_lock_conflicts_total", { reason: "deadlock" }))).toEqual([]);
  });

  it("D22.11: métrica sem lista e label que a lista da métrica não tem falham", async () => {
    expect(labelNameViolations(registryWith("metrica_sem_lista_total", {}))).toEqual([
      "metrica_sem_lista_total: sem lista de labels",
    ]);
    expect(labelNameViolations(registryWith("wallet_lock_conflicts_total", { walletId: "w-1" }))).toEqual([
      "wallet_lock_conflicts_total: declara {walletId}, a lista tem {reason}",
    ]);
  });

  it("D22.4 D22.11: um code fora da lista vira reason=OTHER; os conhecidos passam iguais", () => {
    expect(dlqReason("CODIGO_NOVO_QUE_NINGUEM_LISTOU")).toBe("OTHER");
    expect(dlqReason("VALIDATION_ERROR")).toBe("VALIDATION_ERROR");
    expect(dlqReason("ATTEMPTS_EXHAUSTED")).toBe("ATTEMPTS_EXHAUSTED");
    // Os motivos do lock não são motivos da DLQ (listas por métrica).
    expect(dlqReason("deadlock")).toBe("OTHER");
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

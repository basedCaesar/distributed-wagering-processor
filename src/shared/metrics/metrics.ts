import { Counter, Registry } from "prom-client";

/**
 * Registry do processo (D11.2). O endpoint `/metrics` chega na S9; até lá
 * as métricas já são contadas aqui (D16.6).
 */
export const metricsRegistry = new Registry();

/** Execuções de reconciliação com divergência (R-09-19, D6.9). */
export const reconciliationDivergencesTotal = new Counter({
  name: "reconciliation_divergences_total",
  help: "Reconciliações que encontraram divergência entre saldo e ledger",
  registers: [metricsRegistry],
});

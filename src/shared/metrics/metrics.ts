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

/** Falhas de publicação de eventos que já passaram de 20 tentativas (D9.6, D20.4): o alerta. */
export const outboxEventsStalledTotal = new Counter({
  name: "outbox_events_stalled_total",
  help: "Falhas de publicação de eventos da outbox com 20 tentativas ou mais (o evento continua sendo tentado)",
  registers: [metricsRegistry],
});

/** Eventos que o auditor recebeu fora de ordem por (wallet, tipo) (D20.1). */
export const auditedEventsOutOfOrderTotal = new Counter({
  name: "audited_events_out_of_order_total",
  help: "Eventos de integração com walletVersion menor ou igual à última auditada da mesma wallet e tipo",
  registers: [metricsRegistry],
});

/** Duplicatas de submissão pela camada que as pegou (D11.2, D17.7). */
export const wageringDuplicatesTotal = new Counter({
  name: "wagering_duplicates_total",
  help: "Submissões duplicadas, pela camada que detectou a duplicata",
  labelNames: ["layer"] as const,
  registers: [metricsRegistry],
});

# shared/metrics

Registry `prom-client` do processo (D11.2). O endpoint `/metrics` chega na S9; até lá, as métricas já são contadas (D16.6).

| Métrica | Tipo | Quando |
|---|---|---|
| `reconciliation_divergences_total` | counter | uma reconciliação encontrou divergência (R-09-19, D6.9) |

A `application/` não importa `prom-client`: conta pela porta `ReconciliationMetrics`, e o adaptador fica em `src/modules/wagering/infra/observability/`.

Teste: `test/integration/wallets/reconciliation.spec.ts` (a métrica sobe uma vez por divergência e não sobe numa wallet íntegra).

# shared/metrics

Registry `prom-client` do processo (D11.2). O endpoint `/metrics` chega na S9; até lá, as métricas já são contadas (D16.6).

| Métrica | Tipo | Quando |
|---|---|---|
| `reconciliation_divergences_total` | counter | uma reconciliação encontrou divergência (R-09-19, D6.9) |
| `wagering_duplicates_total{layer}` | counter | uma submissão duplicada foi detectada: `fast_path` (checagem rápida, antes do lock), `lock` (checagem autoritativa, sob o lock da wallet) ou `unique_index` (o `UNIQUE` de key ou de id externo barrou o commit) (D11.2, D17.7) |

A `application/` não importa `prom-client`: conta pelas portas `ReconciliationMetrics` e `SubmissionMetrics`, e os adaptadores ficam em `src/modules/wagering/infra/observability/`.

Testes:
- `test/integration/wallets/reconciliation.spec.ts`: a métrica sobe uma vez por divergência e não sobe numa wallet íntegra;
- `test/concurrency/submit-transaction.spec.ts`: nas 50 BETs iguais, `fast_path + lock = 49` e `unique_index = 0`; a mesma key em duas wallets conta `unique_index = 1`;
- `test/unit/application/submit-wager-transaction.spec.ts`: a repetição depois do `UNIQUE` não conta de novo.

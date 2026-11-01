# shared/metrics

Registry `prom-client` do processo (D11.2). O endpoint `/metrics` chega na S9; até lá, as métricas já são contadas (D16.6).

| Métrica | Tipo | Quando |
|---|---|---|
| `reconciliation_divergences_total` | counter | uma reconciliação encontrou divergência (R-09-19, D6.9) |
| `wagering_duplicates_total{layer}` | counter | uma submissão duplicada foi detectada: `fast_path` (checagem rápida, antes do lock), `lock` (checagem autoritativa, sob o lock da wallet) ou `unique_index` (o `UNIQUE` de key ou de id externo barrou o commit) (D11.2, D17.7). A inbox da fila conta `inbox` (D19.4) |
| `outbox_events_stalled_total` | counter | uma falha de publicação de um evento com 20 tentativas ou mais: o alerta; o evento continua sendo tentado (D9.6, D20.4) |
| `audited_events_out_of_order_total` | counter | o auditor recebeu um evento com `walletVersion` menor ou igual à última da mesma wallet e do mesmo tipo (D20.1) |

A `application/` não importa `prom-client`: conta pelas portas `ReconciliationMetrics` e `SubmissionMetrics`, e os adaptadores ficam em `src/modules/wagering/infra/observability/`. O publisher e o auditor (infra) recebem um callback (`OutboxAlerts`, `AuditAlerts`) ligado ao contador no módulo Nest, e os testes o trocam.

Testes:
- `test/integration/wallets/reconciliation.spec.ts`: a métrica sobe uma vez por divergência e não sobe numa wallet íntegra;
- `test/concurrency/submit-transaction.spec.ts`: nas 50 BETs iguais, `fast_path + lock = 49` e `unique_index = 0`; a mesma key em duas wallets conta `unique_index = 1`;
- `test/unit/application/submit-wager-transaction.spec.ts`: a repetição depois do `UNIQUE` não conta de novo;
- `test/unit/outbox/outbox-publisher.spec.ts`: o alerta conta a partir da 20ª tentativa, e não antes;
- `test/integration/outbox/event-auditor.spec.ts`: o alarme do auditor dispara uma vez para a versão menor e não dispara para o par Processed/BalanceChanged.

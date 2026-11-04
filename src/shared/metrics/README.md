# shared/metrics

Métricas do processo com `prom-client` 15.x (D11.2, D22.10), servidas em `/metrics`.

## O endpoint (D22.1)

- `metrics-server.ts`: um `Bun.serve` próprio na porta `METRICS_PORT` (padrão 9464), **em todo processo** (`api`, `consumer`, `outbox-publisher`, `pending-worker`, `event-auditor`). Só `GET /metrics`; o resto é `404`. Sem auth.
- `metrics.module.ts`: sobe o servidor no bootstrap e o fecha no shutdown. Cada módulo raiz de `src/app/` o importa.
- A porta pública da `api` **não** serve `/metrics` (`404`). No Compose, a porta 9464 só fica exposta na rede interna (`expose`, sem `ports`), e o nginx não roteia para ela. Fica fora do Swagger: não é da API Nest.
- `METRICS_PORT=0` escolhe uma porta livre (os testes com vários módulos Nest no mesmo processo usam isso).

Para ler de dentro do Compose:

```bash
docker compose exec api bun -e 'console.log(await (await fetch("http://localhost:9464/metrics")).text())'
```

## As métricas

| Métrica | Tipo | Labels | Quando | Decisão |
|---|---|---|---|---|
| `wagering_transactions_total` | counter | `status`, `kind`, `channel` | um estado gravado, **depois do commit**; replay não conta | R-12-03, D22.2 |
| `wagering_duplicates_total` | counter | `layer` | duplicata detectada: `fast_path`, `lock`, `unique_index` ou `inbox` | D17.7 |
| `wagering_retries_total` | counter | `component` | nova tentativa agendada depois de uma falha: `consumer`, `event_auditor` (só depois que o `ChangeMessageVisibility` deu certo), `pending_worker`, `outbox_publisher`, `submission` (a repetição da D3.6) | D22.3 |
| `wagering_dlq_messages_total` | counter | `consumer`, `reason` | o consumidor copiou a mensagem para a DLQ (inclusive se o delete falhou depois); `reason` = o `code` do `classifyError()`, `ATTEMPTS_EXHAUSTED` ou `OTHER` (um `code` fora da lista) | D22.4 |
| `sqs_dlq_depth` | gauge | `queue` | `ApproximateNumberOfMessages` da DLQ, lido **no scrape** (timeout de 1 s); o `consumer` lê a de transações, o `event-auditor` a dele | D22.4 |
| `wallet_lock_wait_seconds` | histograma | `outcome` | o `SELECT … FOR UPDATE` da wallet, nos três canais; `outcome` = `acquired`, `lock_timeout` ou `deadlock` (a espera que falhou também conta) | D22.5 |
| `wallet_lock_conflicts_total` | counter | `reason` | o lock da wallet falhou: `lock_timeout` (55P03) ou `deadlock` (40P01) | D22.5 |
| `outbox_pending_events` | gauge | — | eventos não publicados, lido no scrape pelo `outbox-publisher` | D22.6 |
| `outbox_lag_seconds` | gauge | — | idade do não publicado mais antigo (0 sem nenhum), lido no scrape | D22.6 |
| `wagering_processing_duration_seconds` | histograma | `channel`, `outcome` | a chamada ao use case: controller, `process()` do consumidor, tentativa do worker | D22.7 |
| `wagering_refund_after_settlement_total` | counter | `channel` | um `REFUND` **aplicado** a uma `BET` com `WIN`/`LOSS` `PROCESSED`; também loga `warn` `refund_after_settlement` com ids | D1.7, D22.8 |
| `reconciliation_divergences_total` | counter | — | uma reconciliação encontrou divergência | R-09-19, D6.9 |
| `outbox_events_stalled_total` | counter | — | falha de publicação com 20 tentativas ou mais (o alerta) | D9.6, D20.4 |
| `audited_events_out_of_order_total` | counter | — | o auditor recebeu um evento fora de ordem por (wallet, tipo) | D20.1 |

Os gauges lidos no scrape têm uma fonte registrada pelo processo dono (`registerDlqDepthSource`, `registerOutboxBacklogSource`, via `infra/observability/gauges.ts`). Leitura que falha ou estoura o prazo: log `warn` e o gauge fica com o último valor.

### Redrive do SQS × contador de DLQ (D22.4)

A mensagem que o **redrive do SQS** move para a DLQ (`maxReceiveCount = 20`, D8.3, D19.3: por exemplo, quando o banco está fora e o consumidor não consegue nem contar a tentativa) **não passa pelo consumidor**. Por isso ela **não** entra em `wagering_dlq_messages_total`: aparece só em `sqs_dlq_depth`. Uma diferença entre o crescimento da profundidade e o contador é justamente o que o redrive moveu.

## Labels: só conjuntos fechados (D22.11)

`METRIC_LABEL_VALUES` em `metrics.ts` é, **por métrica**, a lista de cada label e dos valores possíveis: o `reason` da DLQ não aceita `deadlock`, e o do conflito de lock não aceita `NOT_FOUND`. Nenhum label carrega id (`walletId`, `transactionId`, `providerId`, `playerId`, `messageId`, `eventId`): os ids ficam nos logs (D11.1). Um `code` fora da lista da DLQ vira `OTHER` (`dlqReason`, D22.4): o conjunto continua fechado mesmo quando surge um código novo.

O verificador fica em `test/support/metrics.ts` (`labelNameViolations`, `closedSetViolations`), usado pelos testes de unidade e de integração.

## Camadas

A `application/` não importa `prom-client`: conta pelas portas `ReconciliationMetrics`, `SubmissionMetrics` e `TransactionMetrics`, com adaptadores em `src/modules/wagering/infra/observability/`. A infra (repositório, consumidor, worker, publisher, controllers) usa os objetos de `metrics.ts` diretamente.

## Testes

- `test/unit/metrics/metric-labels.spec.ts`: toda métrica tem lista própria com exatamente os labels que declara, nenhum label é um id, o verificador pega o valor de uma métrica usado na outra (`wallet_lock_conflicts_total{reason="NOT_FOUND"}`), o `code` desconhecido vira `OTHER`, e todas as métricas da D11.2 estão registradas (D22.11);
- `test/integration/observability/metrics.spec.ts`: cada situação dispara e a métrica muda: transações por status, kind e canal (HTTP, fila, worker, `OPENING`; replay não conta), duplicatas, retries de cada componente (inclusive `event_auditor` e a repetição da D3.6; `ChangeMessageVisibility` que falha não conta), DLQ por motivo (`VALIDATION_ERROR`, `ATTEMPTS_EXHAUSTED`, `OTHER`, delete que falha depois da cópia) e profundidade (que mantém o último valor e loga `warn` quando a leitura estoura o prazo), espera com `outcome`, `lock_timeout` e deadlock real, pendentes e lag da outbox, latência por canal, `refund_after_settlement`; no fim, todo valor de label observado está na lista da própria métrica;
- `test/integration/observability/metrics-endpoint.spec.ts`: os 5 processos reais servem `/metrics` na porta interna sem token; a porta pública da `api` dá `404`; cada processo conta o que fez (montagem de produção), inclusive os gauges da outbox, com um evento parado (`Publish` segurado num proxy na frente do LocalStack real): `outbox_pending_events >= 1` e `outbox_lag_seconds > 0`;
- `test/unit/application/transaction-metrics.spec.ts` e `resolve-pending-metrics.spec.ts`: o use case conta depois do commit, não conta replay nem commit que falhou, e só consulta a liquidação para um `REFUND` aplicado;
- `test/integration/wallets/reconciliation.spec.ts`, `test/concurrency/submit-transaction.spec.ts`, `test/unit/outbox/outbox-publisher.spec.ts`, `test/integration/outbox/event-auditor.spec.ts`: as métricas da reconciliação, da submissão, do publisher e do auditor.

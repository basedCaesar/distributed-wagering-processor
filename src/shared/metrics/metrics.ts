import { Counter, Gauge, Histogram, Registry } from "prom-client";

/**
 * Registry do processo (D11.2), servido em `/metrics` na porta interna
 * (D22.1). `prom-client` 15.x (D22.10).
 */
export const metricsRegistry = new Registry();

const CHANNELS = ["http", "sqs", "worker"] as const;
const LOCK_CONFLICT_REASONS = ["lock_timeout", "deadlock"] as const;
/**
 * Motivos da DLQ (D22.4): os `code` do `classifyError()`, o
 * `ATTEMPTS_EXHAUSTED` e o `OTHER`, para um `code` que não está aqui.
 */
const DLQ_REASONS = [
  "VALIDATION_ERROR",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "WALLET_ALREADY_EXISTS",
  "EXTERNAL_ID_CONFLICT",
  "IDEMPOTENCY_KEY_CONFLICT",
  "INBOX_MESSAGE_CONFLICT",
  "TEMPORARILY_UNAVAILABLE",
  "INTERNAL_ERROR",
  "ATTEMPTS_EXHAUSTED",
  "OTHER",
] as const;

/**
 * Os únicos valores de cada label, **por métrica** (D22.11): conjuntos
 * fechados, nunca ids. Dois labels com o mesmo nome em métricas diferentes
 * (`reason`, `outcome`) têm listas diferentes. Os testes percorrem o
 * registry e falham com uma métrica fora daqui, um label que ela não
 * declara aqui ou um valor fora da lista dela.
 */
export const METRIC_LABEL_VALUES = {
  reconciliation_divergences_total: {},
  outbox_events_stalled_total: {},
  audited_events_out_of_order_total: {},
  accounting_entries_posted_total: {},
  wagering_duplicates_total: { layer: ["fast_path", "lock", "unique_index", "inbox"] },
  wagering_transactions_total: {
    status: ["PROCESSED", "REJECTED", "PENDING_REFERENCE", "FAILED"],
    kind: ["OPENING", "BET", "WIN", "LOSS", "REFUND", "ROLLBACK"],
    channel: CHANNELS,
  },
  wagering_retries_total: {
    component: ["consumer", "event_auditor", "pending_worker", "outbox_publisher", "submission", "accounting_consumer"],
  },
  wagering_dlq_messages_total: { consumer: ["wager_transactions", "event_auditor", "accounting"], reason: DLQ_REASONS },
  wallet_lock_wait_seconds: { outcome: ["acquired", ...LOCK_CONFLICT_REASONS] },
  wallet_lock_conflicts_total: { reason: LOCK_CONFLICT_REASONS },
  wagering_processing_duration_seconds: { channel: CHANNELS, outcome: ["ok", "error"] },
  wagering_refund_after_settlement_total: { channel: CHANNELS },
  sqs_dlq_depth: { queue: ["wager_transactions_dlq", "event_auditor_dlq", "accounting_dlq"] },
  outbox_pending_events: {},
  outbox_lag_seconds: {},
  realtime_connections: {},
  realtime_events_total: { outcome: ["forwarded", "ignored", "invalid", "stale"] },
} as const satisfies Record<string, Record<string, readonly string[]>>;

type Labels = typeof METRIC_LABEL_VALUES;

export type MetricChannel = (typeof CHANNELS)[number];
export type RetryComponent = Labels["wagering_retries_total"]["component"][number];
export type DlqConsumer = Labels["wagering_dlq_messages_total"]["consumer"][number];
export type DlqQueue = Labels["sqs_dlq_depth"]["queue"][number];
export type DlqReason = (typeof DLQ_REASONS)[number];
export type LockConflictReason = (typeof LOCK_CONFLICT_REASONS)[number];

/**
 * O `code` do `classifyError()` como motivo da DLQ (D22.4, D22.11): um
 * `code` fora da lista (um `ConflictError` novo, por exemplo) vira `OTHER`.
 * Assim o conjunto continua fechado mesmo quando surge um código novo, e
 * nenhum texto livre chega à métrica.
 */
export function dlqReason(code: string): DlqReason {
  return (DLQ_REASONS as readonly string[]).includes(code) ? (code as DlqReason) : "OTHER";
}

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

/** Lançamentos de partidas dobradas gravados pelo `accounting-consumer` (D27.6). */
export const accountingEntriesPostedTotal = new Counter({
  name: "accounting_entries_posted_total",
  help: "Lançamentos de partidas dobradas gravados no diário do accounting",
  registers: [metricsRegistry],
});

/** Conexões WebSocket abertas nesta instância do `realtime` (D28.11). */
export const realtimeConnections = new Gauge({
  name: "realtime_connections",
  help: "Conexões WebSocket abertas nesta instância do realtime",
  registers: [metricsRegistry],
});

export type RealtimeEventOutcome = Labels["realtime_events_total"]["outcome"][number];

/**
 * Mensagens da fila da instância do `realtime`, pelo desfecho (D28.6,
 * D28.7, D28.11): enviada aos sockets, `eventType` ignorado, inválida ou
 * descartada por idade.
 */
export const realtimeEventsTotal = new Counter({
  name: "realtime_events_total",
  help: "Mensagens da fila do realtime por desfecho (forwarded, ignored, invalid, stale)",
  labelNames: ["outcome"],
  registers: [metricsRegistry],
});

/** Duplicatas de submissão pela camada que as pegou (D11.2, D17.7). */
export const wageringDuplicatesTotal = new Counter({
  name: "wagering_duplicates_total",
  help: "Submissões duplicadas, pela camada que detectou a duplicata",
  labelNames: ["layer"] as const,
  registers: [metricsRegistry],
});

/** Estados gravados, depois do commit; replay não conta (D22.2). */
export const wageringTransactionsTotal = new Counter({
  name: "wagering_transactions_total",
  help: "Transações gravadas por status, kind e canal, contadas depois do commit (replays ficam em wagering_duplicates_total)",
  labelNames: ["status", "kind", "channel"] as const,
  registers: [metricsRegistry],
});

/** Novas tentativas agendadas depois de uma falha, por componente (D22.3). */
export const wageringRetriesTotal = new Counter({
  name: "wagering_retries_total",
  help: "Novas tentativas agendadas depois de uma falha, por componente",
  labelNames: ["component"] as const,
  registers: [metricsRegistry],
});

/**
 * Cópias para a DLQ feitas pelo consumidor, por motivo (D22.4). A mensagem
 * movida pelo redrive do SQS (`maxReceiveCount`) não passa por aqui: só
 * pelo `sqs_dlq_depth`.
 */
export const wageringDlqMessagesTotal = new Counter({
  name: "wagering_dlq_messages_total",
  help: "Mensagens copiadas para a DLQ pelo consumidor, por motivo (o redrive do SQS não entra aqui)",
  labelNames: ["consumer", "reason"] as const,
  registers: [metricsRegistry],
});

/**
 * Espera do `SELECT … FOR UPDATE` da wallet (D22.5), também quando ela
 * termina em `lock_timeout` ou deadlock: `outcome` = `acquired` |
 * `lock_timeout` | `deadlock`.
 */
export const walletLockWaitSeconds = new Histogram({
  name: "wallet_lock_wait_seconds",
  help: "Tempo do SELECT … FOR UPDATE da wallet (espera pelo lock incluída), por desfecho: acquired, lock_timeout ou deadlock",
  labelNames: ["outcome"] as const,
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [metricsRegistry],
});

/** Lock da wallet que não saiu: `lock_timeout` ou deadlock (D22.5). */
export const walletLockConflictsTotal = new Counter({
  name: "wallet_lock_conflicts_total",
  help: "Locks da wallet que falharam por lock_timeout ou deadlock",
  labelNames: ["reason"] as const,
  registers: [metricsRegistry],
});

/** Latência do use case, por canal (D22.7). */
export const wageringProcessingDurationSeconds = new Histogram({
  name: "wagering_processing_duration_seconds",
  help: "Duração do processamento de uma transação (use case), por canal e desfecho",
  labelNames: ["channel", "outcome"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

/** `REFUND` aplicado a uma `BET` já liquidada (D1.7, D22.8). */
export const wageringRefundAfterSettlementTotal = new Counter({
  name: "wagering_refund_after_settlement_total",
  help: "REFUNDs aplicados a uma BET que já tinha WIN ou LOSS PROCESSED (não bloqueia)",
  labelNames: ["channel"] as const,
  registers: [metricsRegistry],
});

/**
 * Fontes dos gauges lidos no scrape (D22.4, D22.6): o processo que tem a
 * fila ou a outbox registra a sua; sem fonte, o gauge fica sem valor. Uma
 * leitura que falha mantém o último valor (quem registra loga o `warn`).
 */
type GaugeSource<T> = () => Promise<T | undefined>;

const dlqDepthSources = new Map<DlqQueue, GaugeSource<number>>();
let outboxBacklogSource: GaugeSource<{ pending: number; lagSeconds: number }> | undefined;
let outboxBacklogRead: Promise<{ pending: number; lagSeconds: number } | undefined> | undefined;

export const sqsDlqDepth = new Gauge({
  name: "sqs_dlq_depth",
  help: "ApproximateNumberOfMessages da DLQ, lido no scrape (inclui as mensagens do redrive do SQS)",
  labelNames: ["queue"] as const,
  registers: [metricsRegistry],
  async collect() {
    await Promise.all(
      [...dlqDepthSources].map(async ([queue, read]) => {
        const depth = await read();
        if (depth !== undefined) this.set({ queue }, depth);
      }),
    );
  },
});

/** Uma leitura da outbox por scrape, para os dois gauges. */
function readOutboxBacklog(): Promise<{ pending: number; lagSeconds: number } | undefined> {
  if (!outboxBacklogSource) return Promise.resolve(undefined);
  outboxBacklogRead ??= outboxBacklogSource().finally(() => {
    outboxBacklogRead = undefined;
  });
  return outboxBacklogRead;
}

export const outboxPendingEvents = new Gauge({
  name: "outbox_pending_events",
  help: "Eventos da outbox ainda não publicados, lido no scrape",
  registers: [metricsRegistry],
  async collect() {
    const backlog = await readOutboxBacklog();
    if (backlog) this.set(backlog.pending);
  },
});

export const outboxLagSeconds = new Gauge({
  name: "outbox_lag_seconds",
  help: "Idade do evento não publicado mais antigo da outbox (0 sem nenhum), lido no scrape",
  registers: [metricsRegistry],
  async collect() {
    const backlog = await readOutboxBacklog();
    if (backlog) this.set(backlog.lagSeconds);
  },
});

/** Registra a leitura da profundidade de uma DLQ; devolve a função que desfaz. */
export function registerDlqDepthSource(queue: DlqQueue, read: GaugeSource<number>): () => void {
  dlqDepthSources.set(queue, read);
  return () => {
    if (dlqDepthSources.get(queue) === read) dlqDepthSources.delete(queue);
  };
}

/** Registra a leitura do atraso da outbox; devolve a função que desfaz. */
export function registerOutboxBacklogSource(read: GaugeSource<{ pending: number; lagSeconds: number }>): () => void {
  outboxBacklogSource = read;
  return () => {
    if (outboxBacklogSource === read) outboxBacklogSource = undefined;
  };
}

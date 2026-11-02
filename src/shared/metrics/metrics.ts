import { Counter, Gauge, Histogram, Registry } from "prom-client";

/**
 * Registry do processo (D11.2), servido em `/metrics` na porta interna
 * (D22.1). `prom-client` 15.x (D22.10).
 */
export const metricsRegistry = new Registry();

/**
 * Os únicos valores que cada label pode ter (D22.11): conjuntos fechados,
 * nunca ids. Um teste de unidade percorre o registry e falha com um label
 * fora daqui; os adaptadores trocam um valor fora do conjunto por `OTHER`.
 */
export const METRIC_LABEL_VALUES = {
  status: ["PROCESSED", "REJECTED", "PENDING_REFERENCE", "FAILED"],
  kind: ["OPENING", "BET", "WIN", "LOSS", "REFUND", "ROLLBACK"],
  channel: ["http", "sqs", "worker"],
  layer: ["fast_path", "lock", "unique_index", "inbox"],
  component: ["consumer", "event_auditor", "pending_worker", "outbox_publisher", "submission"],
  consumer: ["wager_transactions", "event_auditor"],
  reason: [
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
    "lock_timeout",
    "deadlock",
    "OTHER",
  ],
  queue: ["wager_transactions_dlq", "event_auditor_dlq"],
  outcome: ["ok", "error"],
} as const satisfies Record<string, readonly string[]>;

type LabelValue<L extends keyof typeof METRIC_LABEL_VALUES> = (typeof METRIC_LABEL_VALUES)[L][number];

export type MetricChannel = LabelValue<"channel">;
export type RetryComponent = LabelValue<"component">;
export type DlqConsumer = LabelValue<"consumer">;
export type DlqQueue = LabelValue<"queue">;
export type DlqReason = LabelValue<"reason">;

/** Um valor fora do conjunto fechado vira `OTHER` (D22.11): nunca um texto livre na métrica. */
export function dlqReason(code: string): DlqReason {
  return (METRIC_LABEL_VALUES.reason as readonly string[]).includes(code) ? (code as DlqReason) : "OTHER";
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

/** Espera do `SELECT … FOR UPDATE` da wallet (D22.5). */
export const walletLockWaitSeconds = new Histogram({
  name: "wallet_lock_wait_seconds",
  help: "Tempo do SELECT … FOR UPDATE da wallet (espera pelo lock incluída)",
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

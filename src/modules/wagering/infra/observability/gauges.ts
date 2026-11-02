import type { Logger } from "pino";
import { classifyError } from "../../../../shared/errors/classify-error";
import { withTimeout } from "../../../../shared/health/with-timeout";
import {
  type DlqQueue,
  registerDlqDepthSource,
  registerOutboxBacklogSource,
} from "../../../../shared/metrics/metrics";

/**
 * Uma leitura no scrape, com prazo (o da D11.3). Falhou ou estourou: `warn`
 * e `undefined`, e o gauge fica com o último valor (D22.4, D22.6).
 */
function guarded<T>(read: () => Promise<T>, logger: Logger, timeoutMs: number, what: string) {
  return async (): Promise<T | undefined> => {
    try {
      return await withTimeout(read(), timeoutMs, what);
    } catch (error) {
      const { category, code } = classifyError(error);
      logger.warn({ category, code, gauge: what }, "leitura do gauge falhou; fica o último valor");
      return undefined;
    }
  };
}

/**
 * `sqs_dlq_depth{queue}` no scrape (D22.4): o `ApproximateNumberOfMessages`
 * da DLQ, que conta também o que o redrive do SQS moveu. Devolve a função
 * que desfaz o registro.
 */
export function trackDlqDepth(
  queue: DlqQueue,
  source: { dlqDepth(): Promise<number> },
  logger: Logger,
  timeoutMs: number,
): () => void {
  return registerDlqDepthSource(queue, guarded(() => source.dlqDepth(), logger, timeoutMs, `sqs_dlq_depth:${queue}`));
}

/** `outbox_pending_events` e `outbox_lag_seconds` no scrape (D22.6). */
export function trackOutboxBacklog(
  source: { backlog(): Promise<{ pending: number; lagSeconds: number }> },
  logger: Logger,
  timeoutMs: number,
): () => void {
  return registerOutboxBacklogSource(guarded(() => source.backlog(), logger, timeoutMs, "outbox_backlog"));
}

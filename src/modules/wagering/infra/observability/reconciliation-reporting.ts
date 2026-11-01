import type { Counter } from "prom-client";
import type { Logger } from "pino";
import type {
  ReconciliationLog,
  ReconciliationMetrics,
} from "../../application/ports";

export class PromReconciliationMetrics implements ReconciliationMetrics {
  constructor(private readonly divergences: Counter) {}

  countDivergence(): void {
    this.divergences.inc();
  }
}

/** Log de erro com os códigos das divergências; nunca saldos (D11.1). */
export class PinoReconciliationLog implements ReconciliationLog {
  constructor(private readonly logger: Logger) {}

  divergence(details: Parameters<ReconciliationLog["divergence"]>[0]): void {
    this.logger.error(details, "reconciliação encontrou divergência");
  }
}

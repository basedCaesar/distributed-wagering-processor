import type { Logger } from "pino";
import {
  wageringRefundAfterSettlementTotal,
  wageringRetriesTotal,
  wageringTransactionsTotal,
} from "../../../../shared/metrics/metrics";
import type {
  RefundAfterSettlement,
  TransactionDecision,
  TransactionMetrics,
} from "../../application/ports";

/**
 * `TransactionMetrics` sobre o registry do processo (D22.2, D22.3, D22.8).
 * Os labels são enums fechados (D22.11); os ids vão só para o log.
 */
export class PromTransactionMetrics implements TransactionMetrics {
  constructor(private readonly logger: Logger) {}

  countDecision({ status, kind, channel }: TransactionDecision): void {
    wageringTransactionsTotal.inc({ status, kind, channel });
  }

  countSubmissionRetry(): void {
    wageringRetriesTotal.inc({ component: "submission" });
  }

  /** Não bloqueia (D1.7): métrica e um `warn` só com ids, nunca valores (D11.1). */
  refundAfterSettlement(event: RefundAfterSettlement): void {
    wageringRefundAfterSettlementTotal.inc({ channel: event.channel });
    this.logger.warn(
      {
        transactionId: event.transactionId,
        walletId: event.walletId,
        referenceTransactionId: event.referenceTransactionId,
        channel: event.channel,
      },
      "refund_after_settlement",
    );
  }
}

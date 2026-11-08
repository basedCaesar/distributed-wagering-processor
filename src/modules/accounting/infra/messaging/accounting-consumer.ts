import type { RecordEventHalfUseCase } from "../../application/record-event-half.use-case";
import type { ConsumerPolicy } from "../../../wagering/infra/messaging/consumer-policy";
import { type MessageParser, SqsConsumer, type SqsConsumerDeps } from "../../../wagering/infra/messaging/sqs-consumer";
import { parseAccountingEvent } from "./accounting-event.schema";

/** Nome do consumidor na inbox e no `message_attempts` do accounting (D27.5). */
export const ACCOUNTING_CONSUMER_NAME = "accounting-consumer";

export interface AccountingMetrics {
  countPosted(): void;
}

export interface AccountingConsumerDeps extends SqsConsumerDeps {
  record: RecordEventHalfUseCase;
  metrics: AccountingMetrics;
}

/**
 * `accounting-consumer` (D27): lê a fila assinante do tópico de eventos e
 * grava as metades e o diário de partidas dobradas. O laço, a taxonomia de
 * erros, a DLQ própria e o `stop()` são os do laço genérico (`SqsConsumer`,
 * D20.2, D27.5, D27.8). Logs só com ids e o tipo do evento (D11.1).
 */
export class AccountingConsumer extends SqsConsumer {
  constructor(deps: AccountingConsumerDeps, policy: Partial<ConsumerPolicy> = {}) {
    const consumerName = policy.consumerName ?? ACCOUNTING_CONSUMER_NAME;
    super(deps, accountingParser(deps, consumerName), { ...policy, consumerName }, {
      component: "accounting_consumer",
      consumer: "accounting",
    });
  }
}

function accountingParser(deps: AccountingConsumerDeps, consumerName: string): MessageParser {
  return (body) => {
    const event = parseAccountingEvent(body);
    return {
      messageId: event.eventId,
      context: {
        correlationId: event.correlationId,
        messageId: event.eventId,
        ...(event.walletId !== undefined && { walletId: event.walletId }),
        ...(event.half !== undefined && { transactionId: event.half.transactionId }),
      },
      async process() {
        const { half } = event;
        if (half === undefined) {
          deps.logger.debug({ eventType: event.eventType }, "evento sem efeito no diário");
          return "processed";
        }
        const result = await deps.record.execute(half, event.envelope, consumerName);
        if (result.kind === "duplicate") return "duplicate";
        const fields = { eventType: event.eventType, walletVersion: half.walletVersion };
        if (result.kind === "posted") {
          deps.metrics.countPosted();
          deps.logger.info({ ...fields, entryId: result.entryId }, "lançamento gravado no diário");
        } else {
          deps.logger.info(fields, "metade gravada; esperando a outra");
        }
        return "processed";
      },
    };
  };
}

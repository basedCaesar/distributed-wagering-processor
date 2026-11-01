import type { Logger } from "pino";
import type { SubmitWagerTransactionUseCase } from "../../application/submit-wager-transaction.use-case";
import { CONSUMER_POLICY, type ConsumerPolicy } from "./consumer-policy";
import { type MessageParser, SqsConsumer, type SqsConsumerDeps } from "./sqs-consumer";
import { parseWagerMessage } from "./wager-message.schema";

export { abortableDelay, type MessageOutcome } from "./sqs-consumer";

export interface ConsumerDeps extends SqsConsumerDeps {
  submit: SubmitWagerTransactionUseCase;
  /** Lista de moedas aceitas (D2.5): o mesmo schema do HTTP. */
  currencies: readonly string[];
}

/**
 * Consumidor da `wager-transactions.fifo` (R-10-*, D8, D19). O laço, a
 * taxonomia de erros, a DLQ e o `stop()` são do `SqsConsumer` (D20.2);
 * aqui fica o que é das transações: o envelope do §10 (D19.5) e a chamada
 * ao **mesmo** use case do HTTP, com a inbox (R-10-03, D19.4).
 */
export class WagerTransactionsConsumer extends SqsConsumer {
  constructor(deps: ConsumerDeps, policy: Partial<ConsumerPolicy> = {}) {
    const consumerName = policy.consumerName ?? CONSUMER_POLICY.consumerName;
    super(deps, wagerMessageParser(deps, consumerName), policy);
  }
}

function wagerMessageParser(
  deps: Pick<ConsumerDeps, "submit" | "currencies"> & { logger: Logger },
  consumerName: string,
): MessageParser {
  return (body) => {
    const { messageId, type, command } = parseWagerMessage(body, deps.currencies);
    return {
      messageId,
      context: {
        correlationId: messageId,
        messageId,
        walletId: command.walletId,
        providerId: command.providerId,
      },
      async process() {
        // correlationId e causationId = o messageId do corpo (D9.5).
        const result = await deps.submit.execute(
          command,
          { correlationId: messageId, causationId: messageId },
          { consumerName, messageId, type },
        );
        if ("duplicateMessage" in result) return "duplicate";
        deps.logger.info(
          { transactionId: result.transaction.id, status: result.transaction.status, replay: result.idempotentReplay },
          "mensagem processada",
        );
        return "processed";
      },
    };
  };
}

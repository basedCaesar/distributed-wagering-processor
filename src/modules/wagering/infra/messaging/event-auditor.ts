import type { AuditIntegrationEventUseCase } from "../../application/audit-integration-event.use-case";
import type { ConsumerPolicy } from "./consumer-policy";
import { parseEventEnvelope } from "./event-envelope.schema";
import { type MessageParser, SqsConsumer, type SqsConsumerDeps } from "./sqs-consumer";

/** Nome do auditor na inbox e no `message_attempts` (D9.7, D20.1). */
export const EVENT_AUDITOR_NAME = "event-auditor";

/** O alarme da D20.1: evento fora de ordem por (wallet, tipo). */
export interface AuditAlerts {
  countOutOfOrder(): void;
}

export interface EventAuditorDeps extends SqsConsumerDeps {
  audit: AuditIntegrationEventUseCase;
  alerts: AuditAlerts;
}

/**
 * `event-auditor` (R-11-03, D9.7, D20): lê a fila assinante do tópico de
 * eventos e deduplica pelo `eventId` com a inbox. O laço, a taxonomia de
 * erros, a DLQ própria e o `stop()` são os do consumidor (`SqsConsumer`,
 * D20.2). Evento fora de ordem por (wallet, tipo) → log `error` e métrica;
 * a linha é gravada mesmo assim (D20.1).
 */
export class EventAuditor extends SqsConsumer {
  constructor(deps: EventAuditorDeps, policy: Partial<ConsumerPolicy> = {}) {
    const consumerName = policy.consumerName ?? EVENT_AUDITOR_NAME;
    super(deps, auditParser(deps, consumerName), { ...policy, consumerName });
  }
}

function auditParser(deps: EventAuditorDeps, consumerName: string): MessageParser {
  return (body) => {
    const event = parseEventEnvelope(body);
    return {
      messageId: event.eventId,
      context: {
        correlationId: event.correlationId,
        messageId: event.eventId,
        ...(event.walletId !== undefined && { walletId: event.walletId }),
      },
      async process() {
        const result = await deps.audit.execute(event, consumerName);
        if (result.kind === "duplicate") return "duplicate";
        const fields = { eventType: event.eventType, walletVersion: event.walletVersion };
        if (result.inOrder === false) {
          deps.alerts.countOutOfOrder();
          deps.logger.error(fields, "evento fora de ordem: walletVersion não é maior que a última do mesmo tipo");
        } else {
          deps.logger.info(fields, "evento auditado");
        }
        return "processed";
      },
    };
  };
}

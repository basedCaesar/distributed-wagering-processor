import { InboxConflictError } from "./errors";
import { envelopeHash } from "./payload-hash";
import type { UnitOfWork } from "./ports";

/** Um evento de integração recebido pelo auditor, já validado (D20.2). */
export interface AuditableEvent {
  eventId: string;
  eventType: string;
  aggregateId: string;
  occurredAt: Date;
  /** Do `data`, quando o evento os tem (D20.1). */
  walletId?: string;
  walletVersion?: number;
  /** O envelope como chegou: entra no hash da inbox (D20.1). */
  envelope: unknown;
}

export type AuditResult = { kind: "audited"; inOrder: boolean | null } | { kind: "duplicate" };

/**
 * O efeito do `event-auditor` (R-11-03, D9.7, D20.1), numa transação só:
 * 1. inbox por `(consumerName, eventId)`, com o hash do envelope: já
 *    processado → duplicata, sem efeito; outro conteúdo → `InboxConflictError`
 *    (permanente, D20.2);
 * 2. checagem de ordem por **(wallet, tipo de evento)**: a `walletVersion`
 *    tem de ser estritamente maior que a última auditada da mesma wallet e
 *    do mesmo tipo. Pela wallet só, o par `WagerTransactionProcessed` +
 *    `WalletBalanceChanged` da mesma transação (mesma versão, D9.4) seria
 *    alarme falso;
 * 3. a linha em `audited_events`, gravada mesmo fora de ordem: o alarme é
 *    de quem chama (log e métrica).
 *
 * As mensagens de uma wallet chegam em sequência (FIFO por `walletId`,
 * D9.1), então a leitura da última versão não disputa com outra instância.
 */
export class AuditIntegrationEventUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  execute(event: AuditableEvent, consumerName: string): Promise<AuditResult> {
    const hash = envelopeHash(event.envelope);
    return this.uow.run(async (tx) => {
      const registration = await tx.inbox.register({ consumerName, messageId: event.eventId, hash });
      if (registration === "conflict") throw new InboxConflictError();
      if (registration === "duplicate") return { kind: "duplicate" };

      let inOrder: boolean | null = null;
      if (event.walletId !== undefined && event.walletVersion !== undefined) {
        const last = await tx.auditedEvents.lastWalletVersion(event.walletId, event.eventType);
        inOrder = last === undefined || event.walletVersion > last;
      }
      await tx.auditedEvents.insert({
        eventId: event.eventId,
        eventType: event.eventType,
        aggregateId: event.aggregateId,
        ...(event.walletId !== undefined && { walletId: event.walletId }),
        ...(event.walletVersion !== undefined && { walletVersion: event.walletVersion }),
        inOrder,
        occurredAt: event.occurredAt,
        auditedAt: await tx.now(),
      });
      return { kind: "audited", inOrder };
    });
  }
}

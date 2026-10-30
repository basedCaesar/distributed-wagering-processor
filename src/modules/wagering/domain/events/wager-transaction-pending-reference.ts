import {
  type WagerTransaction,
  type WagerTransactionKind,
  WagerTransactionStatus,
} from "../wager-transaction";
import type { EventContext } from "./event-context";
import { IntegrationEvent } from "./integration-event";
import {
  assertStatus,
  type TransactionEventIds,
  transactionEventIds,
} from "./transaction-event-ids";

/** D9.4. */
export interface WagerTransactionPendingReferenceData
  extends TransactionEventIds {
  kind: WagerTransactionKind;
  referenceExternalTransactionId: string;
}

/**
 * Referência ausente (§11). Emitido uma vez, ao entrar no estado (D4.6).
 * `aggregateId` = transação (D9.3).
 */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  static from(
    tx: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionPendingReference {
    assertStatus(
      tx,
      WagerTransactionStatus.PendingReference,
      "WagerTransactionPendingReference",
    );
    return Object.freeze(
      new WagerTransactionPendingReference({
        ...ctx,
        aggregateId: tx.id,
        data: {
          ...transactionEventIds(tx),
          kind: tx.kind,
          referenceExternalTransactionId:
            tx.referenceExternalTransactionId as string,
        },
      }),
    );
  }
}

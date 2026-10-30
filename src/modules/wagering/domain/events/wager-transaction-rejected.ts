import type { FailureCode } from "../failure-code";
import type { MoneyProps } from "../money";
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
export interface WagerTransactionRejectedData extends TransactionEventIds {
  kind: WagerTransactionKind;
  money: MoneyProps;
  failureCode: FailureCode;
}

/** Rejeitada por regra de negócio (§11). `aggregateId` = transação (D9.3). */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  static from(
    tx: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionRejected {
    assertStatus(
      tx,
      WagerTransactionStatus.Rejected,
      "WagerTransactionRejected",
    );
    return Object.freeze(
      new WagerTransactionRejected({
        ...ctx,
        aggregateId: tx.id,
        data: {
          ...transactionEventIds(tx),
          kind: tx.kind,
          money: tx.money.toJSON(),
          failureCode: tx.failureCode as FailureCode,
        },
      }),
    );
  }
}

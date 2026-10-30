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

/** D9.4, D14.4. */
export interface WagerTransactionFailedData extends TransactionEventIds {
  kind: WagerTransactionKind;
  money: MoneyProps;
  failureCode: FailureCode;
}

/** Evento extra do `FAILED` (D9.4, D4.2). `aggregateId` = transação (D9.3). */
export class WagerTransactionFailed extends IntegrationEvent<WagerTransactionFailedData> {
  readonly eventType = "WagerTransactionFailed";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionFailed {
    assertStatus(tx, WagerTransactionStatus.Failed, "WagerTransactionFailed");
    return Object.freeze(
      new WagerTransactionFailed({
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

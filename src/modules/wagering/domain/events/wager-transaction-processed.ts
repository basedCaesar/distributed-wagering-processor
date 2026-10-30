import type { MoneyProps } from "../money";
import {
  type WagerTransaction,
  type WagerTransactionKind,
  WagerTransactionStatus,
} from "../wager-transaction";
import type { WalletLedgerEntry } from "../wallet-ledger-entry";
import type { EventContext } from "./event-context";
import { IntegrationEvent } from "./integration-event";
import {
  assertStatus,
  type TransactionEventIds,
  transactionEventIds,
} from "./transaction-event-ids";

/** D9.4. `walletVersion` só quando o saldo mudou. */
export interface WagerTransactionProcessedData extends TransactionEventIds {
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceTransactionId?: string;
  balanceAfter: MoneyProps;
  walletVersion?: number;
}

/** Qualquer transação aplicada, inclusive `LOSS` (§11). `aggregateId` = transação (D9.3). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  static from(
    tx: WagerTransaction,
    entry: WalletLedgerEntry | undefined,
    ctx: EventContext,
  ): WagerTransactionProcessed {
    assertStatus(
      tx,
      WagerTransactionStatus.Processed,
      "WagerTransactionProcessed",
    );
    const balanceAfter = tx.balanceAfter as NonNullable<typeof tx.balanceAfter>;
    return Object.freeze(
      new WagerTransactionProcessed({
        ...ctx,
        aggregateId: tx.id,
        data: {
          ...transactionEventIds(tx),
          kind: tx.kind,
          money: tx.money.toJSON(),
          ...(tx.referenceTransactionId !== undefined && {
            referenceTransactionId: tx.referenceTransactionId,
          }),
          balanceAfter: balanceAfter.toJSON(),
          ...(entry && { walletVersion: entry.walletVersion }),
        },
      }),
    );
  }
}

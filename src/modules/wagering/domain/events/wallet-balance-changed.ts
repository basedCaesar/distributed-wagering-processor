import { InvalidWalletOperationError } from "../domain-error";
import type { MoneyProps } from "../money";
import type { Wallet } from "../wallet";
import type {
  LedgerDirection,
  WalletLedgerEntry,
} from "../wallet-ledger-entry";
import type { EventContext } from "./event-context";
import { IntegrationEvent } from "./integration-event";

/** Formato do enunciado (R-11-11). */
export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Emitido somente quando o saldo muda (§11). `aggregateId` = wallet (D9.3). */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  static from(
    wallet: Wallet,
    entry: WalletLedgerEntry,
    ctx: EventContext,
  ): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) {
      throw new InvalidWalletOperationError(
        "Lançamento de outra wallet no WalletBalanceChanged",
      );
    }
    return Object.freeze(
      new WalletBalanceChanged({
        ...ctx,
        aggregateId: wallet.id,
        data: {
          walletId: wallet.id,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          walletVersion: entry.walletVersion,
        },
      }),
    );
  }
}

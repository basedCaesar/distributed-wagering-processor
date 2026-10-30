import { InvalidWalletOperationError } from "../domain-error";
import type { MoneyProps } from "../money";
import type { Wallet } from "../wallet";
import type { EventContext } from "./event-context";
import { IntegrationEvent } from "./integration-event";

/** D9.4, D14.4. */
export interface WalletOpenedData {
  walletId: string;
  playerId: string;
  currency: string;
  initialBalance: MoneyProps;
  walletVersion: number;
}

/** Evento extra da abertura (D9.4). `aggregateId` = wallet (D9.3). */
export class WalletOpened extends IntegrationEvent<WalletOpenedData> {
  readonly eventType = "WalletOpened";
  readonly version = 1;

  /** Só para uma wallet recém-aberta: o saldo atual é o inicial. */
  static from(wallet: Wallet, ctx: EventContext): WalletOpened {
    if (wallet.version !== 1) {
      throw new InvalidWalletOperationError(
        "WalletOpened só para wallet recém-aberta",
      );
    }
    return Object.freeze(
      new WalletOpened({
        ...ctx,
        aggregateId: wallet.id,
        data: {
          walletId: wallet.id,
          playerId: wallet.playerId,
          currency: wallet.currency,
          initialBalance: wallet.balance.toJSON(),
          walletVersion: wallet.version,
        },
      }),
    );
  }
}

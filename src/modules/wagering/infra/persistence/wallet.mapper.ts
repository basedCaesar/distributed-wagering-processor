import { Money } from "../../domain/money";
import { Wallet } from "../../domain/wallet";
import type { WalletRecord } from "./wallet.schema";

/** A `version` vai como o domínio deixou: o ORM não a incrementa (D7.2). */
export function walletToRecord(wallet: Wallet): WalletRecord {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toString(),
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

export function walletFromRecord(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    currency: record.currency,
    balance: Money.rehydrate({
      amount: record.balance,
      currency: record.currency,
    }),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

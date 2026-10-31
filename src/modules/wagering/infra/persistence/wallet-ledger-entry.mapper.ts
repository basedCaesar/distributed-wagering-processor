import { Money } from "../../domain/money";
import {
  type LedgerDirection,
  WalletLedgerEntry,
} from "../../domain/wallet-ledger-entry";
import type { WalletLedgerEntryRecord } from "./wallet-ledger-entry.schema";

export function ledgerEntryToRecord(
  entry: WalletLedgerEntry,
): WalletLedgerEntryRecord {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: entry.money.toString(),
    currency: entry.money.currency,
    balanceBefore: entry.balanceBefore.toString(),
    balanceAfter: entry.balanceAfter.toString(),
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt,
  };
}

export function ledgerEntryFromRecord(
  record: WalletLedgerEntryRecord,
): WalletLedgerEntry {
  const money = (amount: string) =>
    Money.rehydrate({ amount, currency: record.currency });
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    direction: record.direction as LedgerDirection,
    money: money(record.amount),
    balanceBefore: money(record.balanceBefore),
    balanceAfter: money(record.balanceAfter),
    walletVersion: record.walletVersion,
    createdAt: record.createdAt,
  });
}

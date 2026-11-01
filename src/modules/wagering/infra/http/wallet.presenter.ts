import type { LedgerPage } from "../../application/wallet-queries";
import type { Wallet } from "../../domain/wallet";
import type { WalletLedgerEntry } from "../../domain/wallet-ledger-entry";
import type { WalletReconciliation } from "../../domain/wallet-reconciliation";

/** Contratos de saída (R-09-04, R-09-18, D5). */
export function presentWallet(wallet: Wallet) {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}

function presentLedgerEntry(entry: WalletLedgerEntry) {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt.toISOString(),
  };
}

export function presentLedgerPage(page: LedgerPage) {
  return {
    items: page.items.map(presentLedgerEntry),
    nextCursor: page.nextCursor,
  };
}

export function presentReconciliation(report: WalletReconciliation) {
  return {
    walletId: report.walletId,
    storedBalance: report.storedBalance.toJSON(),
    calculatedBalance: report.calculatedBalance.toJSON(),
    difference: report.difference.toJSON(),
    consistent: report.consistent,
    checkedEntries: report.checkedEntries,
    issues: report.issues,
  };
}

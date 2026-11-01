import { Money } from "./money";
import type { Wallet } from "./wallet";
import { LedgerDirection, type WalletLedgerEntry } from "./wallet-ledger-entry";

/** D16.5: uma checagem da D6.9 por código. */
export enum ReconciliationIssueCode {
  /** Σ créditos − Σ débitos ≠ saldo armazenado. */
  BalanceMismatch = "BALANCE_MISMATCH",
  /** `balanceBefore` do lançamento ≠ `balanceAfter` do anterior (ou ≠ 0 no primeiro, D16.11). */
  ChainBreak = "CHAIN_BREAK",
  /** Último `balanceAfter` (ou 0 sem lançamento) ≠ saldo armazenado (D16.12). */
  TailMismatch = "TAIL_MISMATCH",
}

export interface ReconciliationIssue {
  code: ReconciliationIssueCode;
  /** Só no `CHAIN_BREAK`: a versão do lançamento que não encadeia. */
  walletVersion?: number;
}

export interface WalletReconciliation {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  /** Armazenado − calculado, com sinal (D2.6). */
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
  issues: ReconciliationIssue[];
}

/**
 * Reconstrução independente do saldo (D6.9, L715): soma os lançamentos,
 * confere o encadeamento e a cauda. Lê o que está gravado, inclusive
 * adulterado, e **não corrige nada**. `entries` em ordem de `walletVersion`.
 */
export function reconcileWallet(
  wallet: Wallet,
  entries: readonly WalletLedgerEntry[],
): WalletReconciliation {
  const zero = Money.zero(wallet.currency);
  let calculated = zero;
  let previousAfter = zero;
  const chainBreaks: ReconciliationIssue[] = [];

  for (const entry of entries) {
    calculated =
      entry.direction === LedgerDirection.Credit
        ? calculated.add(entry.money)
        : calculated.subtract(entry.money);
    if (!entry.balanceBefore.equals(previousAfter)) {
      chainBreaks.push({
        code: ReconciliationIssueCode.ChainBreak,
        walletVersion: entry.walletVersion,
      });
    }
    previousAfter = entry.balanceAfter;
  }

  const stored = wallet.balance;
  const issues: ReconciliationIssue[] = [];
  if (!calculated.equals(stored)) {
    issues.push({ code: ReconciliationIssueCode.BalanceMismatch });
  }
  issues.push(...chainBreaks);
  if (!previousAfter.equals(stored)) {
    issues.push({ code: ReconciliationIssueCode.TailMismatch });
  }

  return {
    walletId: wallet.id,
    storedBalance: stored,
    calculatedBalance: calculated,
    difference: stored.subtract(calculated),
    consistent: issues.length === 0,
    checkedEntries: entries.length,
    issues,
  };
}

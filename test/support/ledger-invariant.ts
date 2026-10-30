import { expect } from "bun:test";
import { Money } from "../../src/modules/wagering/domain/money";
import type { Wallet } from "../../src/modules/wagering/domain/wallet";
import {
  LedgerDirection,
  type WalletLedgerEntry,
} from "../../src/modules/wagering/domain/wallet-ledger-entry";

export interface WalletBook {
  wallet: Wallet;
  entries: readonly WalletLedgerEntry[];
}

/**
 * D11.4 (versão de unidade, sobre os lançamentos devolvidos pelo domínio):
 * saldo = Σ créditos − Σ débitos, encadeamento, versões contíguas e
 * saldo nunca negativo. A versão com banco vem na S2.
 */
export function expectLedgerMatchesBalances(...books: WalletBook[]): void {
  for (const { wallet, entries } of books) {
    let calculated = Money.zero(wallet.currency);
    let previous: WalletLedgerEntry | undefined;

    for (const entry of entries) {
      expect(entry.walletId).toBe(wallet.id);
      expect(entry.isBalanced()).toBe(true);
      expect(entry.balanceAfter.isNegative()).toBe(false);
      if (previous) {
        expect(entry.balanceBefore.equals(previous.balanceAfter)).toBe(true);
        expect(entry.walletVersion).toBe(previous.walletVersion + 1);
      } else {
        expect(entry.balanceBefore.isZero()).toBe(true);
      }
      calculated =
        entry.direction === LedgerDirection.Credit
          ? calculated.add(entry.money)
          : calculated.subtract(entry.money);
      previous = entry;
    }

    expect(calculated.equals(wallet.balance)).toBe(true);
    expect(wallet.balance.isNegative()).toBe(false);
    if (previous) {
      expect(previous.balanceAfter.equals(wallet.balance)).toBe(true);
      expect(previous.walletVersion).toBe(wallet.version);
    } else {
      expect(wallet.balance.isZero()).toBe(true);
    }
  }
}

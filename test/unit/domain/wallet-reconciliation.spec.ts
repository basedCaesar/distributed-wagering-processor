import { describe, expect, it } from "bun:test";
import { Money } from "../../../src/modules/wagering/domain/money";
import { Wallet } from "../../../src/modules/wagering/domain/wallet";
import {
  LedgerDirection,
  WalletLedgerEntry,
} from "../../../src/modules/wagering/domain/wallet-ledger-entry";
import {
  ReconciliationIssueCode,
  reconcileWallet,
} from "../../../src/modules/wagering/domain/wallet-reconciliation";

const brl = (amount: string) => Money.rehydrate({ amount, currency: "BRL" });

function walletWith(balance: string, version: number): Wallet {
  const at = new Date();
  return Wallet.rehydrate({
    id: "wallet-1",
    playerId: "player-1",
    currency: "BRL",
    balance: brl(balance),
    version,
    createdAt: at,
    updatedAt: at,
  });
}

/** Lançamento sem validação: a reconciliação lê o que está gravado, inclusive adulterado. */
function entry(
  walletVersion: number,
  direction: LedgerDirection,
  amount: string,
  before: string,
  after: string,
): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: `entry-${walletVersion}`,
    walletId: "wallet-1",
    transactionId: `tx-${walletVersion}`,
    direction,
    money: brl(amount),
    balanceBefore: brl(before),
    balanceAfter: brl(after),
    walletVersion,
    createdAt: new Date(),
  });
}

const { Credit, Debit } = LedgerDirection;

const healthy = [
  entry(1, Credit, "100.00", "0.00", "100.00"),
  entry(2, Debit, "25.00", "100.00", "75.00"),
  entry(3, Credit, "10.00", "75.00", "85.00"),
];

describe("S3 D6.9 D16.5: reconciliação de uma wallet (domínio)", () => {
  it("D6.9: wallet íntegra → consistent, diferença zero, checkedEntries = lançamentos", () => {
    const report = reconcileWallet(walletWith("85.00", 3), healthy);

    expect(report.storedBalance.toString()).toBe("85.00");
    expect(report.calculatedBalance.toString()).toBe("85.00");
    expect(report.difference.toString()).toBe("0.00");
    expect(report.consistent).toBe(true);
    expect(report.checkedEntries).toBe(3);
    expect(report.issues).toEqual([]);
  });

  it("D6.9 D2.3: wallet sem lançamentos (saldo inicial zero) é consistente", () => {
    const report = reconcileWallet(walletWith("0.00", 1), []);

    expect(report.calculatedBalance.toString()).toBe("0.00");
    expect(report.consistent).toBe(true);
    expect(report.checkedEntries).toBe(0);
  });

  it("D6.9 D2.6 D16.5: saldo armazenado sem lançamento → BALANCE_MISMATCH + TAIL_MISMATCH, diferença com sinal", () => {
    const report = reconcileWallet(walletWith("80.00", 3), healthy);

    expect(report.consistent).toBe(false);
    expect(report.difference.toString()).toBe("-5.00");
    expect(report.issues).toEqual([
      { code: ReconciliationIssueCode.BalanceMismatch },
      { code: ReconciliationIssueCode.TailMismatch },
    ]);
  });

  it("D6.9 D16.5: lançamento do meio adulterado → CHAIN_BREAK na versão seguinte + BALANCE_MISMATCH", () => {
    const tampered = [
      healthy[0] as WalletLedgerEntry,
      entry(2, Debit, "20.00", "100.00", "80.00"),
      healthy[2] as WalletLedgerEntry,
    ];

    const report = reconcileWallet(walletWith("85.00", 3), tampered);

    expect(report.consistent).toBe(false);
    expect(report.calculatedBalance.toString()).toBe("90.00");
    expect(report.difference.toString()).toBe("-5.00");
    expect(report.issues).toEqual([
      { code: ReconciliationIssueCode.BalanceMismatch },
      { code: ReconciliationIssueCode.ChainBreak, walletVersion: 3 },
    ]);
  });

  it("D6.9 D16.5: primeiro lançamento que não parte de zero → CHAIN_BREAK na versão dele", () => {
    const report = reconcileWallet(walletWith("110.00", 1), [
      entry(1, Credit, "100.00", "10.00", "110.00"),
    ]);

    expect(report.issues).toEqual([
      { code: ReconciliationIssueCode.BalanceMismatch },
      { code: ReconciliationIssueCode.ChainBreak, walletVersion: 1 },
    ]);
  });

  it("D6.9: a reconciliação não corrige a wallet", () => {
    const wallet = walletWith("80.00", 3);

    reconcileWallet(wallet, healthy);

    expect(wallet.balance.toString()).toBe("80.00");
    expect(wallet.version).toBe(3);
  });
});

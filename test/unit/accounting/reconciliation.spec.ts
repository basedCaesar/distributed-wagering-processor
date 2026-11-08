import { describe, expect, it } from "bun:test";
import {
  type AccountingWalletState,
  type CoreWalletState,
  type ReconciliationInput,
  reconcileAccounting,
} from "../../../src/modules/accounting/domain/accounting-reconciliation";

const W = "0196f0aa-0000-7000-8000-000000000001";

const core = (balance: string, version: number): CoreWalletState => ({ walletId: W, currency: "BRL", balance, version });

/** A conta da wallet com as metades lançadas (versão, antes, depois). */
function account(accountBalance: string, posted: [number, string, string][]): AccountingWalletState {
  return {
    walletId: W,
    currency: "BRL",
    accountBalance,
    posted: posted.map(([walletVersion, balanceBefore, balanceAfter]) => ({ walletVersion, balanceBefore, balanceAfter })),
  };
}

function input(overrides: Partial<ReconciliationInput>): ReconciliationInput {
  return {
    trialBalance: [{ currency: "BRL", debits: "100.00", credits: "100.00" }],
    accounting: [],
    core: [],
    incompletePairs: 0,
    ...overrides,
  };
}

const walletOf = (report: ReturnType<typeof reconcileAccounting>) => {
  const [wallet] = report.wallets;
  if (!wallet) throw new Error("sem wallet no relatório");
  return wallet;
};

describe("D27.7: reconciliação do diário contra o núcleo", () => {
  it("D27.7: OPENING 100 + BET 25 lançados, núcleo em 75.00 na versão 2 → consistente e assentada", () => {
    const report = reconcileAccounting(
      input({
        accounting: [account("75.00", [[1, "0.00", "100.00"], [2, "100.00", "75.00"]])],
        core: [core("75.00", 2)],
      }),
    );

    expect(walletOf(report)).toEqual({ walletId: W, status: "consistent", postedVersion: 2, coreVersion: 2, issues: [] });
    expect(report.consistent).toBe(true);
    expect(report.settled).toBe(true);
    expect(report.counts).toEqual({ consistent: 1, lagging: 0, divergent: 0 });
  });

  it("D27.1 D27.7: wallet aberta com saldo zero (sem OPENING) e sem lançamento → consistente", () => {
    const report = reconcileAccounting(input({ core: [core("0.00", 1)] }));

    expect(walletOf(report)).toEqual({ walletId: W, status: "consistent", postedVersion: null, coreVersion: 1, issues: [] });
  });

  it("D27.1 D27.7: wallet sem OPENING, primeira mudança na versão 2 a partir de 0 → consistente", () => {
    const report = reconcileAccounting(
      input({ accounting: [account("10.00", [[2, "0.00", "10.00"]])], core: [core("10.00", 2)] }),
    );

    expect(walletOf(report).status).toBe("consistent");
  });

  it("D27.7: núcleo à frente do diário → atrasada (não é divergência); não assentada, mas consistente", () => {
    const report = reconcileAccounting(
      input({ accounting: [account("100.00", [[1, "0.00", "100.00"]])], core: [core("75.00", 2)] }),
    );

    expect(walletOf(report)).toEqual({
      walletId: W,
      status: "lagging",
      postedVersion: 1,
      coreVersion: 2,
      issues: ["EVENTS_PENDING"],
    });
    expect(report.consistent).toBe(true);
    expect(report.settled).toBe(false);
  });

  it("D27.4 D27.7: buraco na sequência (versão 3 chegou antes da 2) → atrasada, sem acusar a continuidade", () => {
    const report = reconcileAccounting(
      input({
        accounting: [account("90.00", [[1, "0.00", "100.00"], [3, "75.00", "65.00"]])],
        core: [core("65.00", 3)],
      }),
    );

    expect(walletOf(report).status).toBe("lagging");
    expect(walletOf(report).issues).toEqual(["EVENTS_PENDING"]);
  });

  it("D27.7: OPENING ainda não consumida (núcleo com 100.00 na versão 1, diário vazio) → atrasada", () => {
    const report = reconcileAccounting(input({ core: [core("100.00", 1)] }));

    expect(walletOf(report).status).toBe("lagging");
  });

  it("D27.7: mesma versão, saldo diferente → divergente, inconsistente", () => {
    const report = reconcileAccounting(
      input({
        accounting: [account("75.00", [[1, "0.00", "100.00"], [2, "100.00", "75.00"]])],
        core: [core("80.00", 2)],
      }),
    );

    expect(walletOf(report).status).toBe("divergent");
    expect(walletOf(report).issues).toEqual(["CORE_BALANCE_MISMATCH"]);
    expect(report.consistent).toBe(false);
  });

  it("D27.7: saldo da conta diferente do último balanceAfter → divergente", () => {
    const report = reconcileAccounting(
      input({
        accounting: [account("70.00", [[1, "0.00", "100.00"], [2, "100.00", "75.00"]])],
        core: [core("75.00", 2)],
      }),
    );

    expect(walletOf(report).issues).toContain("ACCOUNT_BALANCE_MISMATCH");
    expect(walletOf(report).status).toBe("divergent");
  });

  it("D6.9 D27.7: continuidade quebrada (balanceBefore ≠ balanceAfter anterior, versões seguidas) → divergente", () => {
    const report = reconcileAccounting(
      input({
        accounting: [account("70.00", [[1, "0.00", "100.00"], [2, "95.00", "70.00"]])],
        core: [core("70.00", 2)],
      }),
    );

    expect(walletOf(report).issues).toContain("CHAIN_BROKEN");
  });

  it("D27.7: OPENING (versão 1) lançada partindo de saldo ≠ 0 → divergente", () => {
    const report = reconcileAccounting(
      input({ accounting: [account("100.00", [[1, "5.00", "105.00"]])], core: [core("105.00", 1)] }),
    );

    expect(walletOf(report).issues).toContain("CHAIN_BROKEN");
  });

  it("D27.7: diário à frente do núcleo → divergente", () => {
    const report = reconcileAccounting(
      input({
        accounting: [account("75.00", [[1, "0.00", "100.00"], [2, "100.00", "75.00"]])],
        core: [core("100.00", 1)],
      }),
    );

    expect(walletOf(report).issues).toContain("VERSION_AHEAD");
  });

  it("D27.7: conta de wallet que o núcleo não tem → divergente", () => {
    const report = reconcileAccounting(input({ accounting: [account("100.00", [[1, "0.00", "100.00"]])] }));

    expect(walletOf(report)).toMatchObject({ status: "divergent", issues: ["WALLET_NOT_IN_CORE"], coreVersion: null });
  });

  it("D27.7: moeda da conta diferente da wallet → divergente", () => {
    const report = reconcileAccounting(
      input({
        accounting: [{ ...account("100.00", [[1, "0.00", "100.00"]]), currency: "USD" }],
        core: [core("100.00", 1)],
      }),
    );

    expect(walletOf(report).issues).toContain("CURRENCY_MISMATCH");
  });

  it("§6.4 D27.7: Σ débitos − Σ créditos ≠ 0 numa moeda → inconsistente, com a diferença", () => {
    const report = reconcileAccounting(
      input({
        trialBalance: [
          { currency: "BRL", debits: "100.00", credits: "100.00" },
          { currency: "USD", debits: "10.00", credits: "9.99" },
        ],
      }),
    );

    expect(report.trialBalance).toEqual([
      { currency: "BRL", difference: "0.00", balanced: true },
      { currency: "USD", difference: "0.01", balanced: false },
    ]);
    expect(report.consistent).toBe(false);
  });

  it("D27.7: pares incompletos → não assentada, mas consistente", () => {
    const report = reconcileAccounting(input({ incompletePairs: 2 }));

    expect(report.incompletePairs).toBe(2);
    expect(report.settled).toBe(false);
    expect(report.consistent).toBe(true);
  });
});

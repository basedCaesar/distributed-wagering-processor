import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { Client } from "pg";
import { reconciliationDivergencesTotal } from "../../../src/shared/metrics/metrics";
import {
  type ErrorBody,
  type MoneyJson,
  startTestApi,
  type TestApi,
} from "../../support/api";
import { connect, newId } from "../../support/db";
import { expectLedgerMatchesBalances } from "../../support/db-ledger-invariant";
import { credit, debitBet, seedWallet } from "../../support/db-seed";
import {
  type Tampering,
  tamperLedgerEntry,
  tamperWalletBalance,
} from "../../support/tamper";

interface ReconciliationBody {
  walletId: string;
  storedBalance: MoneyJson;
  calculatedBalance: MoneyJson;
  difference: MoneyJson;
  consistent: boolean;
  checkedEntries: number;
  issues: { code: string; walletVersion?: number }[];
}

let api: TestApi;
let db: Client;
let tampering: Tampering | undefined;

beforeAll(async () => {
  api = await startTestApi();
  db = await connect("app");
});

// A wallet adulterada volta ao normal antes de qualquer outro teste (o
// invariante do banco confere todas as wallets).
afterEach(async () => {
  await tampering?.restore();
  tampering = undefined;
});

afterAll(async () => {
  await api.close();
  await db.end();
  await expectLedgerMatchesBalances();
});

const brl = (amount: string) => ({ amount, currency: "BRL" });

async function reconcile(walletId: string): Promise<ReconciliationBody> {
  const response = await api.request("POST", `/wallets/${walletId}/reconciliation`);
  expect(response.status).toBe(200);
  return (await response.json()) as ReconciliationBody;
}

/** OPENING 100 (v1), BET 30 (v2), WIN 5 (v3): saldo 75.00. */
async function walletWithHistory() {
  const wallet = await seedWallet(db, { balance: "100.00" });
  await debitBet(db, wallet, "30.00");
  await credit(db, wallet, "5.00");
  return wallet;
}

async function divergenceCount(): Promise<number> {
  const metric = await reconciliationDivergencesTotal.get();
  return metric.values[0]?.value ?? 0;
}

async function runsOf(walletId: string) {
  const { rows } = await db.query(
    `SELECT stored_balance::text AS stored, calculated_balance::text AS calculated,
            difference::text AS difference, checked_entries, consistent, issues
       FROM reconciliation_runs WHERE wallet_id = $1 ORDER BY executed_at`,
    [walletId],
  );
  return rows;
}

describe("S3 R-09-18 R-09-19 D6.9: POST /wallets/:id/reconciliation", () => {
  it("R-09-18 D6.9 D16.5: wallet íntegra → consistent true, diferença 0.00, issues vazia, execução gravada", async () => {
    const wallet = await walletWithHistory();
    const before = await divergenceCount();

    const body = await reconcile(wallet.id);

    expect(body).toEqual({
      walletId: wallet.id,
      storedBalance: brl("75.00"),
      calculatedBalance: brl("75.00"),
      difference: brl("0.00"),
      consistent: true,
      checkedEntries: 3,
      issues: [],
    });
    expect(await divergenceCount()).toBe(before);
    expect(await runsOf(wallet.id)).toEqual([
      {
        stored: "75.00",
        calculated: "75.00",
        difference: "0.00",
        checked_entries: 3,
        consistent: true,
        issues: [],
      },
    ]);
  });

  it("R-09-19 D6.9 D16.5 D16.6: saldo adulterado pelo dono → consistent false, log de erro e métrica", async () => {
    const wallet = await walletWithHistory();
    tampering = await tamperWalletBalance(wallet.id, "80.00");
    const before = await divergenceCount();

    const body = await reconcile(wallet.id);

    expect(body).toMatchObject({
      storedBalance: brl("80.00"),
      calculatedBalance: brl("75.00"),
      difference: brl("5.00"),
      consistent: false,
      checkedEntries: 3,
      issues: [{ code: "BALANCE_MISMATCH" }, { code: "TAIL_MISMATCH" }],
    });
    expect(await divergenceCount()).toBe(before + 1);
    const log = api.logs.find(
      (line) => line.walletId === wallet.id && line.level === 50,
    );
    expect(log).toMatchObject({
      walletId: wallet.id,
      issues: ["BALANCE_MISMATCH", "TAIL_MISMATCH"],
      checkedEntries: 3,
    });
    // D11.1: o log não leva saldos nem a diferença.
    const dump = JSON.stringify(log);
    expect(dump).not.toContain("80.00");
    expect(dump).not.toContain("75.00");
    expect(dump).not.toContain("5.00");
    const [run] = await runsOf(wallet.id);
    expect(run).toMatchObject({ consistent: false, difference: "5.00" });
  });

  it("R-09-19 D6.9 D16.5: lançamento do meio adulterado → CHAIN_BREAK na versão seguinte", async () => {
    const wallet = await walletWithHistory();
    // v2 era BET 30 (100 → 70); passa a dizer 20 (100 → 80).
    tampering = await tamperLedgerEntry(wallet.id, 2, {
      amount: "20.00",
      balanceAfter: "80.00",
    });

    const body = await reconcile(wallet.id);

    expect(body).toMatchObject({
      storedBalance: brl("75.00"),
      calculatedBalance: brl("85.00"),
      difference: { amount: "-10.00", currency: "BRL" },
      consistent: false,
      issues: [
        { code: "BALANCE_MISMATCH" },
        { code: "CHAIN_BREAK", walletVersion: 3 },
      ],
    });
  });

  it("R-09-19 D6.9: a reconciliação não corrige nada", async () => {
    const wallet = await walletWithHistory();
    tampering = await tamperWalletBalance(wallet.id, "80.00");

    await reconcile(wallet.id);
    const second = await reconcile(wallet.id);

    expect(second.storedBalance).toEqual(brl("80.00"));
    expect(second.consistent).toBe(false);
  });

  it("D6.9 D2.3: wallet sem lançamentos → consistente, checkedEntries 0", async () => {
    const wallet = await seedWallet(db, { balance: "0.00" });

    expect(await reconcile(wallet.id)).toMatchObject({
      storedBalance: brl("0.00"),
      calculatedBalance: brl("0.00"),
      consistent: true,
      checkedEntries: 0,
    });
  });

  it("D5: wallet inexistente → 404", async () => {
    const response = await api.request(
      "POST",
      `/wallets/${newId()}/reconciliation`,
    );
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });
});

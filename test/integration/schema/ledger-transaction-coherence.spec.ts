import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Client } from "pg";
import { expectLedgerMatchesBalances } from "../../support/db-ledger-invariant";
import { connect, expectDbError, newId } from "../../support/db";
import {
  addCents,
  commitMovement,
  credit,
  debitBet,
  insertRow,
  type Row,
  rejected,
  reversalOf,
  type SeededWallet,
  seedWallet,
  subtractCents,
  transactionRow,
  writeMovement,
} from "../../support/db-seed";

// D15.9: lançamento × transação, conferido no COMMIT (constraint triggers
// diferidos). Cada teste grava o movimento inteiro e coerente (transação,
// lançamento, saldo e versão), mudando só o que a regra proíbe; assim a
// cauda (D15.1) passa e só a D15.9 recusa.
describe("S2 R-06-24 R-06-43 R-05-09 D15.9: todo lançamento tem a transação certa e vice-versa", () => {
  let app: Client;

  beforeAll(async () => {
    app = await connect("app");
  });

  afterAll(async () => {
    await expectLedgerMatchesBalances();
    await app.end();
  });

  const fundedWallet = () => seedWallet(app, { balance: "100.00" });

  /**
   * Abre uma transação, grava transação + lançamento + saldo com a direção
   * dada e espera o erro no COMMIT.
   */
  async function expectMovementRejectedAtCommit(
    wallet: SeededWallet,
    direction: "DEBIT" | "CREDIT",
    transaction: Row,
    constraint: string,
  ): Promise<void> {
    const amount = "10.00";
    const after =
      direction === "DEBIT"
        ? subtractCents(wallet.balance, amount)
        : addCents(wallet.balance, amount);
    await app.query("BEGIN");
    try {
      await writeMovement(app, wallet.id, {
        transaction: transactionRow(wallet, {
          amount,
          balance_after: after,
          ...transaction,
        }),
        direction,
        amount,
        balanceBefore: wallet.balance,
        balanceAfter: after,
        walletVersion: wallet.version + 1,
      });
    } catch (error) {
      await app.query("ROLLBACK");
      throw error;
    }

    await expectDbError(app.query("COMMIT"), { code: "23000", constraint });
  }

  describe("lançamento só para transação PROCESSED que move saldo (R-06-43)", () => {
    it("R-06-43 D15.9: lançamento de uma transação REJECTED → erro no COMMIT", async () => {
      const wallet = await fundedWallet();

      await expectMovementRejectedAtCommit(
        wallet,
        "DEBIT",
        rejected,
        "wallet_ledger_entries_transaction_processed",
      );
    });

    it("D4.1 D15.9: lançamento de uma transação PENDING_REFERENCE → erro no COMMIT", async () => {
      const wallet = await fundedWallet();

      await expectMovementRejectedAtCommit(
        wallet,
        "CREDIT",
        {
          kind: "REFUND",
          reference_external_transaction_id: `ext-${newId()}`,
          status: "PENDING_REFERENCE",
          processed_at: null,
          balance_after: null,
          balance_after_currency: null,
        },
        "wallet_ledger_entries_transaction_processed",
      );
    });

    it("R-06-43 D15.9: lançamento de uma LOSS PROCESSED → erro no COMMIT", async () => {
      const wallet = await fundedWallet();

      await expectMovementRejectedAtCommit(
        wallet,
        "DEBIT",
        { kind: "LOSS" },
        "wallet_ledger_entries_transaction_processed",
      );
    });
  });

  describe("direção do lançamento pelo kind", () => {
    it("D15.9: BET com CREDIT → erro no COMMIT", async () => {
      const wallet = await fundedWallet();

      await expectMovementRejectedAtCommit(
        wallet,
        "CREDIT",
        { kind: "BET" },
        "wallet_ledger_entries_direction_by_kind",
      );
    });

    it("D15.9: WIN com DEBIT → erro no COMMIT", async () => {
      const wallet = await fundedWallet();

      await expectMovementRejectedAtCommit(
        wallet,
        "DEBIT",
        { kind: "WIN" },
        "wallet_ledger_entries_direction_by_kind",
      );
    });

    it("D15.9: REFUND com DEBIT → erro no COMMIT", async () => {
      const wallet = await fundedWallet();
      const bet = await debitBet(app, wallet, "10.00");

      await expectMovementRejectedAtCommit(
        wallet,
        "DEBIT",
        { kind: "REFUND", ...reversalOf(bet) },
        "wallet_ledger_entries_direction_by_kind",
      );
    });

    it("D15.9: ROLLBACK de BET com DEBIT (não inverte a referência) → erro no COMMIT", async () => {
      const wallet = await fundedWallet();
      const bet = await debitBet(app, wallet, "10.00");

      await expectMovementRejectedAtCommit(
        wallet,
        "DEBIT",
        { kind: "ROLLBACK", ...reversalOf(bet) },
        "wallet_ledger_entries_direction_by_kind",
      );
    });

    it("D15.9: ROLLBACK de WIN com CREDIT (não inverte a referência) → erro no COMMIT", async () => {
      const wallet = await fundedWallet();
      const bet = await debitBet(app, wallet, "10.00");
      const win = await credit(app, wallet, "10.00", { ...reversalOf(bet) });

      await expectMovementRejectedAtCommit(
        wallet,
        "CREDIT",
        { kind: "ROLLBACK", ...reversalOf(win) },
        "wallet_ledger_entries_direction_by_kind",
      );
    });

    it("D1.2 D15.9: ROLLBACK é o inverso da referência (BET → CREDIT, WIN → DEBIT, REFUND → DEBIT)", async () => {
      const wallet = await fundedWallet();

      const bet = await debitBet(app, wallet, "10.00");
      await commitMovement(app, wallet, "CREDIT", "10.00", {
        kind: "ROLLBACK",
        ...reversalOf(bet),
      });

      const winBet = await debitBet(app, wallet, "5.00");
      const win = await credit(app, wallet, "5.00", { ...reversalOf(winBet) });
      await commitMovement(app, wallet, "DEBIT", "5.00", {
        kind: "ROLLBACK",
        ...reversalOf(win),
      });

      const refundedBet = await debitBet(app, wallet, "3.00");
      const refund = await credit(app, wallet, "3.00", {
        kind: "REFUND",
        ...reversalOf(refundedBet),
      });
      await commitMovement(app, wallet, "DEBIT", "3.00", {
        kind: "ROLLBACK",
        ...reversalOf(refund),
      });

      const { rows } = await app.query(
        "SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = $1",
        [wallet.id],
      );
      expect(rows[0].n).toBe(wallet.version);
    });
  });

  describe("transação PROCESSED que move saldo tem lançamento (R-06-24)", () => {
    it("R-06-24 D15.9: BET PROCESSED sem lançamento → erro no COMMIT", async () => {
      const wallet = await fundedWallet();

      await expectDbError(
        insertRow(app, "wager_transactions", transactionRow(wallet)),
        {
          code: "23000",
          constraint: "wager_transactions_ledger_entry_required",
        },
      );
    });

    it("R-06-24 D15.9: WIN PROCESSED sem lançamento → erro no COMMIT", async () => {
      const wallet = await fundedWallet();

      await expectDbError(
        insertRow(
          app,
          "wager_transactions",
          transactionRow(wallet, {
            kind: "WIN",
            balance_after: wallet.balance,
          }),
        ),
        {
          code: "23000",
          constraint: "wager_transactions_ledger_entry_required",
        },
      );
    });

    it("R-06-24 D15.9: PENDING_REFERENCE → PROCESSED sem lançamento → erro no COMMIT", async () => {
      const wallet = await fundedWallet();
      const bet = await debitBet(app, wallet, "10.00");
      const id = newId();
      await insertRow(
        app,
        "wager_transactions",
        transactionRow(wallet, {
          id,
          kind: "REFUND",
          amount: "10.00",
          reference_external_transaction_id: bet.external_transaction_id,
          status: "PENDING_REFERENCE",
          processed_at: null,
          balance_after: null,
          balance_after_currency: null,
        }),
      );

      await expectDbError(
        app.query(
          `UPDATE wager_transactions
              SET status = 'PROCESSED', reference_transaction_id = $2,
                  balance_after = $3, balance_after_currency = 'BRL', processed_at = now()
            WHERE id = $1`,
          [id, bet.id, wallet.balance],
        ),
        {
          code: "23000",
          constraint: "wager_transactions_ledger_entry_required",
        },
      );
    });

    it("R-06-43 D15.9: LOSS PROCESSED, REJECTED e PENDING_REFERENCE sem lançamento são aceitos", async () => {
      const wallet = await fundedWallet();

      await insertRow(
        app,
        "wager_transactions",
        transactionRow(wallet, { kind: "LOSS", balance_after: wallet.balance }),
      );
      await insertRow(
        app,
        "wager_transactions",
        transactionRow(wallet, { ...rejected, balance_after: wallet.balance }),
      );
      await insertRow(
        app,
        "wager_transactions",
        transactionRow(wallet, {
          kind: "REFUND",
          reference_external_transaction_id: `ext-${newId()}`,
          status: "PENDING_REFERENCE",
          processed_at: null,
          balance_after: null,
          balance_after_currency: null,
        }),
      );
    });
  });
});

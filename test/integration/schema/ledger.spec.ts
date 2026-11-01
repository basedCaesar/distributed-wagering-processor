import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Client } from "pg";
import { expectLedgerMatchesBalances } from "../../support/db-ledger-invariant";
import { connect, expectDbError, newId } from "../../support/db";
import {
  credit,
  debitBet,
  insertRow,
  type Row,
  rejected,
  type SeededWallet,
  seedWallet,
  subtractCents,
  type TransactionRow,
  transactionRow,
  writeMovement,
} from "../../support/db-seed";

// Cada teste cria a própria wallet e calcula o esperado a partir dela:
// nada depende da ordem dos testes.
describe("S2 R-05-05 R-05-09 D7.3: garantias do ledger", () => {
  let app: Client;
  let owner: Client;

  beforeAll(async () => {
    app = await connect("app");
    owner = await connect("owner");
  });

  afterAll(async () => {
    await expectLedgerMatchesBalances();
    await app.end();
    await owner.end();
  });

  /** Wallet com OPENING de 100.00 (lançamento v1). */
  const fundedWallet = () => seedWallet(app, { balance: "100.00" });

  /** Id do lançamento da OPENING de uma wallet nova. */
  async function seedEntry(): Promise<string> {
    const wallet = await fundedWallet();
    const { rows } = await app.query(
      "SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1",
      [wallet.id],
    );
    return rows[0].id;
  }

  /** Débito de 10.00 seguinte ao estado atual da wallet. */
  function nextEntry(wallet: SeededWallet, overrides: Row = {}): Row {
    return {
      id: newId(),
      wallet_id: wallet.id,
      direction: "DEBIT",
      amount: "10.00",
      currency: wallet.currency,
      balance_before: wallet.balance,
      balance_after: subtractCents(wallet.balance, "10.00"),
      wallet_version: wallet.version + 1,
      created_at: new Date(),
      ...overrides,
    };
  }

  /** BET e lançamento, dentro de uma transação já aberta. */
  async function insertEntryInOpenTransaction(
    wallet: SeededWallet,
    overrides: Row,
  ): Promise<void> {
    const tx = transactionRow(wallet);
    await insertRow(app, "wager_transactions", tx);
    await insertRow(
      app,
      "wallet_ledger_entries",
      nextEntry(wallet, { transaction_id: tx.id, ...overrides }),
    );
  }

  async function expectInTransaction(
    work: () => Promise<unknown>,
    expected: { code: string; constraint: string },
  ): Promise<void> {
    await app.query("BEGIN");
    try {
      await expectDbError(work(), expected);
    } finally {
      await app.query("ROLLBACK");
    }
  }

  describe("imutabilidade (R-05-05)", () => {
    it("R-05-05 D7.3: UPDATE no ledger com o papel da app → sem privilégio", async () => {
      const entryId = await seedEntry();

      await expectDbError(
        app.query(
          "UPDATE wallet_ledger_entries SET amount = '1.00' WHERE id = $1",
          [entryId],
        ),
        { code: "42501" },
      );
    });

    it("R-05-05 D7.3: DELETE no ledger com o papel da app → sem privilégio", async () => {
      const entryId = await seedEntry();

      await expectDbError(
        app.query("DELETE FROM wallet_ledger_entries WHERE id = $1", [entryId]),
        { code: "42501" },
      );
    });

    it("R-05-05 D7.3: TRUNCATE no ledger com o papel da app → sem privilégio", async () => {
      await expectDbError(app.query("TRUNCATE wallet_ledger_entries"), {
        code: "42501",
      });
    });

    it("R-05-05 D7.3 (P2, papel dono): UPDATE no ledger → trigger append-only", async () => {
      const entryId = await seedEntry();

      await expectDbError(
        owner.query(
          "UPDATE wallet_ledger_entries SET amount = '1.00' WHERE id = $1",
          [entryId],
        ),
        { code: "23000", constraint: "wallet_ledger_entries_append_only" },
      );
    });

    it("R-05-05 D7.3 (P2, papel dono): DELETE no ledger → trigger append-only", async () => {
      const entryId = await seedEntry();

      await expectDbError(
        owner.query("DELETE FROM wallet_ledger_entries WHERE id = $1", [
          entryId,
        ]),
        { code: "23000", constraint: "wallet_ledger_entries_append_only" },
      );
    });

    it("R-05-05 D7.3 (P2, papel dono): TRUNCATE no ledger → trigger append-only", async () => {
      await expectDbError(owner.query("TRUNCATE wallet_ledger_entries"), {
        code: "23000",
        constraint: "wallet_ledger_entries_append_only",
      });
    });
  });

  describe("não-negatividade e aritmética", () => {
    it("R-06-41 D7.3: aritmética errada (100 − 10 ≠ 80) → CHECK", async () => {
      const wallet = await fundedWallet();

      await expectInTransaction(
        () => insertEntryInOpenTransaction(wallet, { balance_after: "80.00" }),
        { code: "23514", constraint: "wallet_ledger_entries_arithmetic_ck" },
      );
    });

    it("D7.3: lançamento de valor zero → CHECK", async () => {
      const wallet = await fundedWallet();

      await expectInTransaction(
        () =>
          insertEntryInOpenTransaction(wallet, {
            amount: "0.00",
            balance_after: wallet.balance,
          }),
        {
          code: "23514",
          constraint: "wallet_ledger_entries_amount_positive_ck",
        },
      );
    });

    it("R-06-25 D7.3: balance_after negativo → CHECK", async () => {
      const wallet = await fundedWallet();

      await expectInTransaction(
        () =>
          insertEntryInOpenTransaction(wallet, {
            amount: "100.01",
            balance_after: "-0.01",
          }),
        {
          code: "23514",
          constraint: "wallet_ledger_entries_balances_non_negative_ck",
        },
      );
    });
  });

  describe("coerência (encadeamento, cauda, FKs)", () => {
    it("D7.3: lançamento furado (pula uma versão) → trigger de encadeamento", async () => {
      const wallet = await fundedWallet();

      await expectInTransaction(
        () =>
          insertEntryInOpenTransaction(wallet, {
            wallet_version: wallet.version + 2,
          }),
        { code: "23000", constraint: "wallet_ledger_entries_chain" },
      );
    });

    it("D7.3: balance_before ≠ balance_after anterior → trigger de encadeamento", async () => {
      const wallet = await fundedWallet();

      await expectInTransaction(
        () =>
          insertEntryInOpenTransaction(wallet, {
            balance_before: subtractCents(wallet.balance, "50.00"),
            balance_after: subtractCents(wallet.balance, "60.00"),
          }),
        { code: "23000", constraint: "wallet_ledger_entries_chain" },
      );
    });

    it("D6.2 D15.6: primeiro lançamento sem OPENING precisa ser a versão 2", async () => {
      const empty = await seedWallet(app);
      const tx = transactionRow(empty, { kind: "WIN", balance_after: "5.00" });

      await expectInTransaction(
        async () => {
          await insertRow(app, "wager_transactions", tx);
          await insertRow(app, "wallet_ledger_entries", {
            ...nextEntry(empty, {
              transaction_id: tx.id,
              direction: "CREDIT",
              amount: "5.00",
              balance_before: "0.00",
              balance_after: "5.00",
            }),
            wallet_version: 1,
          });
        },
        { code: "23000", constraint: "wallet_ledger_entries_chain" },
      );
    });

    it("D15.6: primeiro lançamento com balance_before ≠ 0 → trigger de encadeamento", async () => {
      const empty = await seedWallet(app);
      const tx = transactionRow(empty, { kind: "WIN", balance_after: "10.00" });

      await expectInTransaction(
        async () => {
          await insertRow(app, "wager_transactions", tx);
          await insertRow(
            app,
            "wallet_ledger_entries",
            nextEntry(empty, {
              transaction_id: tx.id,
              direction: "CREDIT",
              amount: "5.00",
              balance_before: "5.00",
              balance_after: "10.00",
            }),
          );
        },
        { code: "23000", constraint: "wallet_ledger_entries_chain" },
      );
    });

    it("D15.6: OPENING que não é o primeiro lançamento → trigger de encadeamento", async () => {
      // Wallet sem OPENING, já com um WIN (v2): a OPENING ainda cabe no
      // índice de uma por wallet, então só o encadeamento a recusa.
      const wallet = await seedWallet(app);
      await credit(app, wallet, "5.00");
      const opening = transactionRow(wallet, {
        provider_id: null,
        external_transaction_id: null,
        idempotency_key: null,
        payload_hash: null,
        round_id: null,
        game_id: null,
        kind: "OPENING",
        amount: "5.00",
        balance_after: "10.00",
      });

      await expectInTransaction(
        async () => {
          await insertRow(app, "wager_transactions", opening);
          await insertRow(
            app,
            "wallet_ledger_entries",
            nextEntry(wallet, {
              transaction_id: opening.id,
              direction: "CREDIT",
              amount: "5.00",
              balance_after: "10.00",
            }),
          );
        },
        { code: "23000", constraint: "wallet_ledger_entries_chain" },
      );
    });

    it("R-06-21 D7.3: saldo alterado sem lançamento → erro no COMMIT", async () => {
      const wallet = await fundedWallet();
      await app.query("BEGIN");
      await app.query(
        "UPDATE wallets SET balance = balance + 10, version = version + 1 WHERE id = $1",
        [wallet.id],
      );

      await expectDbError(app.query("COMMIT"), {
        code: "23000",
        constraint: "wallets_ledger_tail",
      });
    });

    it("R-06-21 D7.3: lançamento sem alterar o saldo → erro no COMMIT", async () => {
      const wallet = await fundedWallet();
      await app.query("BEGIN");
      await insertEntryInOpenTransaction(wallet, {});

      await expectDbError(app.query("COMMIT"), {
        code: "23000",
        constraint: "wallets_ledger_tail",
      });
    });

    it("R-06-27 D15.1: version alterada sem mudança de saldo → erro no COMMIT", async () => {
      const wallet = await fundedWallet();
      await app.query("BEGIN");
      await app.query(
        "UPDATE wallets SET version = version + 1 WHERE id = $1",
        [wallet.id],
      );

      await expectDbError(app.query("COMMIT"), {
        code: "23000",
        constraint: "wallets_ledger_tail",
      });
    });

    it("R-06-21 D7.3: lançamento + saldo + version coerentes passam no COMMIT", async () => {
      const wallet = await fundedWallet();
      const expected = {
        balance: subtractCents(wallet.balance, "10.00"),
        version: wallet.version + 1,
      };

      await debitBet(app, wallet, "10.00");

      const { rows } = await app.query(
        "SELECT balance::text AS balance, version FROM wallets WHERE id = $1",
        [wallet.id],
      );
      expect(rows[0]).toEqual(expected);
    });

    it("D7.3: um lançamento por transação → UNIQUE", async () => {
      const wallet = await fundedWallet();
      const bet = await debitBet(app, wallet, "1.00");

      await expectInTransaction(
        () =>
          insertRow(
            app,
            "wallet_ledger_entries",
            nextEntry(wallet, {
              transaction_id: bet.id,
              amount: "1.00",
              balance_after: subtractCents(wallet.balance, "1.00"),
            }),
          ),
        { code: "23505", constraint: "wallet_ledger_entries_transaction_uq" },
      );
    });

    it("D15.4: lançamento em moeda diferente da wallet → FK", async () => {
      const wallet = await fundedWallet();

      await expectInTransaction(
        async () => {
          // REJECTED: uma PROCESSED em USD numa wallet BRL nem é gravada (D15.10).
          const tx = transactionRow(wallet, {
            currency: "USD",
            ...rejected,
            failure_code: "CURRENCY_MISMATCH",
          });
          await insertRow(app, "wager_transactions", tx);
          await insertRow(
            app,
            "wallet_ledger_entries",
            nextEntry(wallet, { transaction_id: tx.id, currency: "USD" }),
          );
        },
        {
          code: "23503",
          constraint: "wallet_ledger_entries_wallet_currency_fk",
        },
      );
    });

    it("D15.4: lançamento apontando para transação de outra wallet → FK", async () => {
      const wallet = await fundedWallet();
      const other = await seedWallet(app, { balance: "10.00" });

      await expectInTransaction(
        async () => {
          const otherTx = transactionRow(other);
          await insertRow(app, "wager_transactions", otherTx);
          await insertRow(
            app,
            "wallet_ledger_entries",
            nextEntry(wallet, { transaction_id: otherTx.id }),
          );
        },
        { code: "23503", constraint: "wallet_ledger_entries_transaction_fk" },
      );
    });
  });

  it("D7.2 D15.7: dois escritores sem lock geram a mesma wallet_version → UNIQUE recusa um", async () => {
    const raced = await fundedWallet();
    const before = raced.balance;
    const after = subtractCents(before, "10.00");
    const version = raced.version + 1;
    const writerA = await connect("app");
    const writerB = await connect("app");
    try {
      const movement = (transaction: TransactionRow) => ({
        transaction,
        direction: "DEBIT" as const,
        amount: "10.00",
        balanceBefore: before,
        balanceAfter: after,
        walletVersion: version,
      });

      // A grava a próxima versão e segura a transação aberta.
      await writerA.query("BEGIN");
      await writeMovement(
        writerA,
        raced.id,
        movement(transactionRow(raced, { balance_after: after })),
      );

      // B, sem lock da wallet, calcula a mesma versão a partir da commitada.
      await writerB.query("BEGIN");
      const pidB = (await writerB.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid as number;
      const transactionB = transactionRow(raced, { balance_after: after });
      await insertRow(writerB, "wager_transactions", transactionB);
      const insertB = insertRow(
        writerB,
        "wallet_ledger_entries",
        nextEntry(raced, { transaction_id: transactionB.id }),
      ).catch((error: unknown) => error);

      // B fica esperando o índice único que A segura (estado observável, não sleep).
      await waitUntilBlocked(app, pidB);
      await writerA.query("COMMIT");

      await expectDbError(
        insertB.then((outcome) => {
          if (outcome instanceof Error) throw outcome;
        }),
        {
          code: "23505",
          constraint: "wallet_ledger_entries_wallet_version_uq",
        },
      );
      await writerB.query("ROLLBACK");
    } finally {
      await writerA.end();
      await writerB.end();
    }

    const { rows } = await app.query(
      "SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = $1",
      [raced.id],
    );
    expect(rows[0].n).toBe(version);
  });
});

/** Espera o backend `pid` aparecer esperando um lock em `pg_locks`. */
async function waitUntilBlocked(observer: Client, pid: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query(
      "SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted",
      [pid],
    );
    if (rows.length > 0) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`backend ${pid} não chegou a esperar lock em 5s`);
}

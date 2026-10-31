import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Client } from "pg";
import { expectLedgerMatchesBalances } from "../../support/db-ledger-invariant";
import { connect, expectDbError, inTransaction, newId } from "../../support/db";
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
  transactionRow,
} from "../../support/db-seed";

describe("S2 R-05-09 D7.3: garantias da tabela wager_transactions (papel da app)", () => {
  let app: Client;
  let wallet: SeededWallet;

  beforeAll(async () => {
    app = await connect("app");
    wallet = await seedWallet(app, { balance: "1000.00" });
  });

  afterAll(async () => {
    await expectLedgerMatchesBalances();
    await app.end();
  });

  /**
   * INSERT direto, sem lançamento: só para linhas que não movem saldo
   * (REJECTED, PENDING_REFERENCE, LOSS) ou que o banco deve recusar na hora.
   * Uma transação PROCESSED que move saldo vai por `debitBet`/`credit` (D15.9).
   */
  const insert = (overrides: Row = {}) =>
    insertRow(app, "wager_transactions", transactionRow(wallet, overrides));

  const pendingRefund = (overrides: Row = {}) => ({
    id: newId(),
    kind: "REFUND",
    reference_external_transaction_id: `ext-${newId()}`,
    status: "PENDING_REFERENCE",
    processed_at: null,
    balance_after: null,
    balance_after_currency: null,
    ...overrides,
  });

  /** PENDING_REFERENCE que o worker marcou FAILED: o único jeito de nascer FAILED (D15.5). */
  async function insertFailed(): Promise<string> {
    const row = pendingRefund();
    await insert(row);
    await app.query(
      "UPDATE wager_transactions SET status = 'FAILED', failure_code = 'PROCESSING_FAILED' WHERE id = $1",
      [row.id],
    );
    return row.id;
  }

  describe("unicidade", () => {
    it("R-06-39 D3.1: mesma idempotency key do mesmo provedor → UNIQUE", async () => {
      const key = `key-${newId()}`;
      await debitBet(app, wallet, "1.00", { idempotency_key: key });

      await expectDbError(insert({ idempotency_key: key }), {
        code: "23505",
        constraint: "wager_transactions_provider_key_uq",
      });
    });

    it("D3.1: a mesma key em outro provedor não é duplicata", async () => {
      const key = `key-${newId()}`;
      await debitBet(app, wallet, "1.00", { idempotency_key: key });

      await debitBet(app, wallet, "1.00", {
        idempotency_key: key,
        provider_id: "provider-2",
      });
    });

    it("D3.2: mesmo id externo do mesmo provedor → UNIQUE", async () => {
      const external = `ext-${newId()}`;
      await debitBet(app, wallet, "1.00", {
        external_transaction_id: external,
      });

      await expectDbError(insert({ external_transaction_id: external }), {
        code: "23505",
        constraint: "wager_transactions_provider_external_uq",
      });
    });

    it("R-07-09 D1.1: duas reversões PROCESSED da mesma referência (REFUND + ROLLBACK) → UNIQUE", async () => {
      const bet = await debitBet(app, wallet, "10.00");
      await credit(app, wallet, "10.00", {
        kind: "REFUND",
        ...reversalOf(bet),
      });

      await expectDbError(
        insert({
          kind: "ROLLBACK",
          ...reversalOf(bet),
          balance_after: addCents(wallet.balance, "10.00"),
        }),
        {
          code: "23505",
          constraint: "wager_transactions_one_processed_reversal_uq",
        },
      );
    });

    it("D1.2: ROLLBACK de REFUND referencia o REFUND, não colide com a reversão da BET", async () => {
      const bet = await debitBet(app, wallet, "10.00");
      const refund = await credit(app, wallet, "10.00", {
        kind: "REFUND",
        ...reversalOf(bet),
      });

      await commitMovement(app, wallet, "DEBIT", "10.00", {
        kind: "ROLLBACK",
        ...reversalOf(refund),
      });
    });

    it("R-06-38 D6.1: duas OPENING na mesma wallet → UNIQUE", async () => {
      await expectDbError(
        insert({
          provider_id: null,
          external_transaction_id: null,
          idempotency_key: null,
          payload_hash: null,
          round_id: null,
          game_id: null,
          kind: "OPENING",
        }),
        { code: "23505", constraint: "wager_transactions_one_opening_uq" },
      );
    });
  });

  describe("coerência por kind", () => {
    it("D6.1 D14.5: OPENING com provedor → CHECK", async () => {
      const zeroWallet = await seedWallet(app);

      await expectDbError(
        insertRow(
          app,
          "wager_transactions",
          transactionRow(zeroWallet, { kind: "OPENING", round_id: null }),
        ),
        { code: "23514", constraint: "wager_transactions_provider_columns_ck" },
      );
    });

    it("D6.1: BET sem provedor → CHECK", async () => {
      await expectDbError(insert({ provider_id: null }), {
        code: "23514",
        constraint: "wager_transactions_provider_columns_ck",
      });
    });

    it("D1.5: REFUND sem referência → CHECK", async () => {
      await expectDbError(insert({ kind: "REFUND" }), {
        code: "23514",
        constraint: "wager_transactions_reference_by_kind_ck",
      });
    });

    it("D1.5: BET com referência → CHECK", async () => {
      // REJECTED: isola a regra de kind (PROCESSED exigiria o id interno, D15.3).
      await expectDbError(
        insert({ reference_external_transaction_id: "ext-other", ...rejected }),
        {
          code: "23514",
          constraint: "wager_transactions_reference_by_kind_ck",
        },
      );
    });

    it("D2.3: BET de valor zero → CHECK", async () => {
      await expectDbError(insert({ amount: "0.00" }), {
        code: "23514",
        constraint: "wager_transactions_amount_ck",
      });
    });

    it("D2.3: LOSS de valor zero é aceito; negativo → CHECK", async () => {
      await insert({ kind: "LOSS", amount: "0.00" });

      await expectDbError(insert({ kind: "LOSS", amount: "-1.00" }), {
        code: "23514",
        constraint: "wager_transactions_amount_ck",
      });
    });

    it("D2.5: moeda fora do formato ISO → CHECK", async () => {
      await expectDbError(insert({ currency: "brl", ...rejected }), {
        code: "23514",
        constraint: "wager_transactions_currency_format_ck",
      });
    });

    it("D3.3: payload_hash que não é SHA-256 hex → CHECK", async () => {
      await expectDbError(insert({ payload_hash: "not-a-hash", ...rejected }), {
        code: "23514",
        constraint: "wager_transactions_payload_hash_ck",
      });
    });
  });

  describe("FK composta da referência (D7.3)", () => {
    it("D7.3: referência de outra wallet → FK", async () => {
      const other = await seedWallet(app, { balance: "50.00" });
      const otherBet = await debitBet(app, other, "5.00");

      await expectDbError(insert({ kind: "WIN", ...reversalOf(otherBet) }), {
        code: "23503",
        constraint: "wager_transactions_reference_scope_fk",
      });
    });

    it("D7.3: referência de outra rodada → FK", async () => {
      const bet = await debitBet(app, wallet, "1.00");

      await expectDbError(
        insert({ kind: "WIN", round_id: "round-other", ...reversalOf(bet) }),
        { code: "23503", constraint: "wager_transactions_reference_scope_fk" },
      );
    });

    it("D7.3: referência em outra moeda → FK", async () => {
      const bet = await debitBet(app, wallet, "1.00");

      await expectDbError(
        insert({ kind: "WIN", currency: "USD", ...reversalOf(bet) }),
        { code: "23503", constraint: "wager_transactions_reference_scope_fk" },
      );
    });

    it("D7.3: referência da mesma wallet, moeda e rodada é aceita", async () => {
      const bet = await debitBet(app, wallet, "1.00");

      await credit(app, wallet, "1.00", { kind: "WIN", ...reversalOf(bet) });
    });
  });

  describe("coerência por status (D15.3)", () => {
    it("D4.1 D15.3: status PENDING gravado → CHECK", async () => {
      await expectDbError(insert({ status: "PENDING" }), {
        code: "23514",
        constraint: "wager_transactions_status_ck",
      });
    });

    it("D15.3: PROCESSED sem processed_at → CHECK", async () => {
      await expectDbError(insert({ processed_at: null }), {
        code: "23514",
        constraint: "wager_transactions_processed_ck",
      });
    });

    it("D7.3 D15.3: PROCESSED com referência externa e sem o id interno → CHECK", async () => {
      const bet = await debitBet(app, wallet, "1.00");

      await expectDbError(
        insert({
          kind: "WIN",
          reference_external_transaction_id: bet.external_transaction_id,
        }),
        { code: "23514", constraint: "wager_transactions_processed_ck" },
      );
    });

    it("D15.3: REJECTED sem failure_code → CHECK", async () => {
      await expectDbError(insert({ status: "REJECTED", processed_at: null }), {
        code: "23514",
        constraint: "wager_transactions_rejected_ck",
      });
    });

    it("D14.1 D15.3: REJECTED com PROCESSING_FAILED → CHECK", async () => {
      await expectDbError(
        insert({ ...rejected, failure_code: "PROCESSING_FAILED" }),
        { code: "23514", constraint: "wager_transactions_rejected_ck" },
      );
    });

    it("D14.1 D15.3: FAILED com código de rejeição → CHECK", async () => {
      const row = pendingRefund();
      await insert(row);

      await expectDbError(
        app.query(
          "UPDATE wager_transactions SET status = 'FAILED', failure_code = 'INSUFFICIENT_FUNDS' WHERE id = $1",
          [row.id],
        ),
        { code: "23514", constraint: "wager_transactions_failed_ck" },
      );
    });

    it("D14.3 D15.3: failure_detail sem REFERENCE_SCOPE_MISMATCH → CHECK", async () => {
      await expectDbError(insert({ ...rejected, failure_detail: "ROUND" }), {
        code: "23514",
        constraint: "wager_transactions_failure_detail_ck",
      });
    });

    it("D14.3 D15.3: REFERENCE_SCOPE_MISMATCH sem failure_detail → CHECK", async () => {
      await expectDbError(
        insert({
          kind: "WIN",
          reference_external_transaction_id: "ext-other-round",
          ...rejected,
          failure_code: "REFERENCE_SCOPE_MISMATCH",
        }),
        { code: "23514", constraint: "wager_transactions_failure_detail_ck" },
      );
    });

    it("D14.6 D15.3: reference_transaction_id numa REJECTED → CHECK", async () => {
      const bet = await debitBet(app, wallet, "1.00");

      await expectDbError(
        insert({
          kind: "REFUND",
          ...rejected,
          failure_code: "AMOUNT_MISMATCH",
          ...reversalOf(bet),
        }),
        { code: "23514", constraint: "wager_transactions_reference_id_ck" },
      );
    });

    it("D4.1 D15.3: PENDING_REFERENCE com saldo → CHECK", async () => {
      await expectDbError(
        insert(
          pendingRefund({
            balance_after: "0.00",
            balance_after_currency: "BRL",
          }),
        ),
        {
          code: "23514",
          constraint: "wager_transactions_pending_reference_ck",
        },
      );
    });

    it("D7.3: balance_after negativo → CHECK", async () => {
      await expectDbError(insert({ ...rejected, balance_after: "-1.00" }), {
        code: "23514",
        constraint: "wager_transactions_balance_after_non_negative_ck",
      });
    });

    const currencyMismatch = {
      currency: "USD",
      ...rejected,
      failure_code: "CURRENCY_MISMATCH",
    };

    it("D3.5 D15.8: CURRENCY_MISMATCH guarda o saldo na moeda da wallet", async () => {
      const id = newId();
      await insert({ id, ...currencyMismatch, balance_after_currency: "BRL" });

      const { rows } = await app.query(
        "SELECT currency, balance_after_currency FROM wager_transactions WHERE id = $1",
        [id],
      );
      expect(rows[0]).toEqual({
        currency: "USD",
        balance_after_currency: "BRL",
      });
    });

    it("D15.8: saldo observado numa moeda que não é a da wallet → FK", async () => {
      await expectDbError(
        insert({ ...currencyMismatch, balance_after_currency: "USD" }),
        { code: "23503", constraint: "wager_transactions_balance_currency_fk" },
      );
    });

    it("D15.8: balance_after sem a moeda → CHECK", async () => {
      await expectDbError(
        insert({ ...rejected, balance_after_currency: null }),
        {
          code: "23514",
          constraint: "wager_transactions_balance_after_pair_ck",
        },
      );
    });
  });

  describe("imutabilidade e transições (D7.3, D4.5, D15.5)", () => {
    it("D4.2 D15.5: INSERT de FAILED → recusado (FAILED só nasce de PENDING_REFERENCE)", async () => {
      await expectDbError(
        insert(
          pendingRefund({
            status: "FAILED",
            failure_code: "PROCESSING_FAILED",
          }),
        ),
        { code: "23000", constraint: "wager_transactions_insert_status" },
      );
    });

    it("D4.5 D15.5: PENDING_REFERENCE → PROCESSED, com lançamento e saldo na mesma transação", async () => {
      const bet = await debitBet(app, wallet, "10.00");
      const row = pendingRefund({
        reference_external_transaction_id: bet.external_transaction_id,
        amount: "10.00",
      });
      await insert(row);
      const before = wallet.balance;
      const after = addCents(before, "10.00");
      const version = wallet.version + 1;

      await inTransaction(app, async () => {
        await app.query(
          `UPDATE wager_transactions
              SET status = 'PROCESSED', reference_transaction_id = $2,
                  balance_after = $3, balance_after_currency = 'BRL', processed_at = now()
            WHERE id = $1`,
          [row.id, bet.id, after],
        );
        await insertRow(app, "wallet_ledger_entries", {
          id: newId(),
          wallet_id: wallet.id,
          transaction_id: row.id,
          direction: "CREDIT",
          amount: "10.00",
          currency: "BRL",
          balance_before: before,
          balance_after: after,
          wallet_version: version,
          created_at: new Date(),
        });
        await app.query(
          "UPDATE wallets SET balance = $2, version = $3, updated_at = now() WHERE id = $1",
          [wallet.id, after, version],
        );
      });
      wallet.balance = after;
      wallet.version = version;

      const { rows } = await app.query(
        "SELECT status FROM wager_transactions WHERE id = $1",
        [row.id],
      );
      expect(rows[0]).toEqual({ status: "PROCESSED" });
    });

    it("D4.2 D15.5: PENDING_REFERENCE → FAILED é aceito", async () => {
      const id = await insertFailed();

      const { rows } = await app.query(
        "SELECT status, failure_code FROM wager_transactions WHERE id = $1",
        [id],
      );
      expect(rows[0]).toEqual({
        status: "FAILED",
        failure_code: "PROCESSING_FAILED",
      });
    });

    it("D4.3 D4.5: PENDING_REFERENCE aceita colunas de controle e a transição para REJECTED", async () => {
      const row = pendingRefund();
      await insert(row);

      await app.query(
        "UPDATE wager_transactions SET attempts = attempts + 1, next_attempt_at = now() WHERE id = $1",
        [row.id],
      );
      await app.query(
        `UPDATE wager_transactions
            SET status = 'REJECTED', failure_code = 'REFERENCE_NOT_FOUND',
                balance_after = $2, balance_after_currency = 'BRL'
          WHERE id = $1`,
        [row.id, wallet.balance],
      );
      const { rows } = await app.query(
        "SELECT status, attempts FROM wager_transactions WHERE id = $1",
        [row.id],
      );
      expect(rows[0]).toEqual({ status: "REJECTED", attempts: 1 });
    });

    it("D4.1 D15.5: PENDING_REFERENCE → PENDING → CHECK", async () => {
      const row = pendingRefund();
      await insert(row);

      await expectDbError(
        app.query(
          "UPDATE wager_transactions SET status = 'PENDING' WHERE id = $1",
          [row.id],
        ),
        { code: "23514", constraint: "wager_transactions_status_ck" },
      );
    });

    // Cada destino com as colunas coerentes, para só a regra de terminal recusar.
    const targets: Record<string, string> = {
      PROCESSED:
        "status = 'PROCESSED', failure_code = NULL, failure_detail = NULL, processed_at = now(), balance_after = '0.00', balance_after_currency = 'BRL'",
      REJECTED:
        "status = 'REJECTED', failure_code = 'INSUFFICIENT_FUNDS', failure_detail = NULL, processed_at = NULL, reference_transaction_id = NULL, balance_after = '0.00', balance_after_currency = 'BRL'",
      FAILED:
        "status = 'FAILED', failure_code = 'PROCESSING_FAILED', failure_detail = NULL, processed_at = NULL, reference_transaction_id = NULL, balance_after = NULL, balance_after_currency = NULL",
      PENDING_REFERENCE:
        "status = 'PENDING_REFERENCE', failure_code = NULL, failure_detail = NULL, processed_at = NULL, reference_transaction_id = NULL, balance_after = NULL, balance_after_currency = NULL",
    };
    const terminals: Record<string, () => Promise<string>> = {
      PROCESSED: async () => (await debitBet(app, wallet, "1.00")).id,
      REJECTED: async () => {
        const id = newId();
        await insert({ id, ...rejected });
        return id;
      },
      FAILED: insertFailed,
    };

    for (const [from, seed] of Object.entries(terminals)) {
      for (const [to, set] of Object.entries(targets)) {
        if (to === from) continue;
        it(`R-06-36 D4.5 D15.5: ${from} → ${to} → trigger (terminal não muda)`, async () => {
          const id = await seed();

          await expectDbError(
            app.query(`UPDATE wager_transactions SET ${set} WHERE id = $1`, [
              id,
            ]),
            {
              code: "23000",
              constraint: "wager_transactions_terminal_immutable",
            },
          );
        });
      }
    }

    it("R-06-36 D7.3: UPDATE de qualquer coluna numa terminal → trigger", async () => {
      const bet = await debitBet(app, wallet, "1.00");

      await expectDbError(
        app.query(
          "UPDATE wager_transactions SET balance_after = '1.00' WHERE id = $1",
          [bet.id],
        ),
        { code: "23000", constraint: "wager_transactions_terminal_immutable" },
      );
    });

    it("D7.3: coluna imutável alterada numa PENDING_REFERENCE → trigger", async () => {
      const row = pendingRefund();
      await insert(row);

      await expectDbError(
        app.query(
          "UPDATE wager_transactions SET amount = '99.00' WHERE id = $1",
          [row.id],
        ),
        { code: "23000", constraint: "wager_transactions_immutable_columns" },
      );
    });

    it("D9.5 D7.3: correlation_id de uma PENDING_REFERENCE não muda depois do INSERT → trigger", async () => {
      const row = pendingRefund({ correlation_id: `corr-${newId()}` });
      await insert(row);

      await expectDbError(
        app.query(
          "UPDATE wager_transactions SET correlation_id = 'other' WHERE id = $1",
          [row.id],
        ),
        { code: "23000", constraint: "wager_transactions_immutable_columns" },
      );
    });
  });
});

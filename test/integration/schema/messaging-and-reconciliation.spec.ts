import { afterAll, beforeAll, describe, it } from "bun:test";
import type { Client } from "pg";
import { expectLedgerMatchesBalances } from "../../support/db-ledger-invariant";
import { connect, expectDbError, newId } from "../../support/db";
import { insertRow, seedWallet } from "../../support/db-seed";

describe("S2 D3.7 D6.9 D7.3: inbox, outbox, message_attempts e reconciliation_runs", () => {
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

  const inboxRow = (messageId: string) => ({
    consumer_name: "wager-transactions-consumer",
    message_id: messageId,
    payload_hash: "b".repeat(64),
    received_at: new Date(),
    processed_at: new Date(),
  });

  it("D3.7 D7.3: mesma mensagem (consumer_name, messageId) duas vezes → UNIQUE", async () => {
    const messageId = newId();
    await insertRow(app, "inbox_messages", inboxRow(messageId));

    await expectDbError(insertRow(app, "inbox_messages", inboxRow(messageId)), {
      code: "23505",
      constraint: "inbox_messages_pk",
    });
  });

  it("D3.7: o mesmo messageId em outro consumidor é outra entrada", async () => {
    const messageId = newId();
    await insertRow(app, "inbox_messages", inboxRow(messageId));

    await insertRow(app, "inbox_messages", {
      ...inboxRow(messageId),
      consumer_name: "event-auditor",
    });
  });

  it("D9.2 D9.3: a app grava na outbox (posição gerada pelo banco)", async () => {
    const walletId = newId();
    await insertRow(app, "outbox_messages", {
      id: newId(),
      aggregate_id: walletId,
      ordering_key: walletId,
      event_type: "WalletOpened",
      payload: JSON.stringify({ eventId: "x" }),
      occurred_at: new Date(),
      next_attempt_at: new Date(),
    });
  });

  it("D8.3: a app conta tentativas em message_attempts", async () => {
    await insertRow(app, "message_attempts", {
      consumer_name: "wager-transactions-consumer",
      message_id: newId(),
      attempts: 1,
      last_error_code: "DB_UNAVAILABLE",
      first_attempt_at: new Date(),
      last_attempt_at: new Date(),
    });
  });

  describe("reconciliation_runs é append-only (D6.9)", () => {
    async function seedRun(): Promise<string> {
      const wallet = await seedWallet(app);
      const id = newId();
      await insertRow(app, "reconciliation_runs", {
        id,
        wallet_id: wallet.id,
        currency: "BRL",
        stored_balance: "0.00",
        calculated_balance: "0.00",
        difference: "0.00",
        checked_entries: 0,
        consistent: true,
        issues: "[]",
        executed_at: new Date(),
      });
      return id;
    }

    it("D6.9: UPDATE / DELETE com o papel da app → sem privilégio", async () => {
      const id = await seedRun();

      await expectDbError(
        app.query(
          "UPDATE reconciliation_runs SET consistent = false WHERE id = $1",
          [id],
        ),
        { code: "42501" },
      );
      await expectDbError(
        app.query("DELETE FROM reconciliation_runs WHERE id = $1", [id]),
        { code: "42501" },
      );
    });

    it("D6.9 (P2, papel dono): UPDATE / DELETE / TRUNCATE → trigger append-only", async () => {
      const id = await seedRun();
      const appendOnly = {
        code: "23000",
        constraint: "reconciliation_runs_append_only",
      };

      await expectDbError(
        owner.query(
          "UPDATE reconciliation_runs SET consistent = false WHERE id = $1",
          [id],
        ),
        appendOnly,
      );
      await expectDbError(
        owner.query("DELETE FROM reconciliation_runs WHERE id = $1", [id]),
        appendOnly,
      );
      await expectDbError(
        owner.query("TRUNCATE reconciliation_runs"),
        appendOnly,
      );
    });

    it("D2.6: difference ≠ armazenado − calculado → CHECK", async () => {
      const wallet = await seedWallet(app);

      await expectDbError(
        insertRow(app, "reconciliation_runs", {
          id: newId(),
          wallet_id: wallet.id,
          currency: "BRL",
          stored_balance: "10.00",
          calculated_balance: "15.00",
          difference: "5.00",
          checked_entries: 1,
          consistent: false,
          issues: "[]",
          executed_at: new Date(),
        }),
        { code: "23514", constraint: "reconciliation_runs_difference_ck" },
      );
    });
  });
});

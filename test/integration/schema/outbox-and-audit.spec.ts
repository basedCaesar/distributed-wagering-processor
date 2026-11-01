import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Client } from "pg";
import { connect, expectDbError, newId } from "../../support/db";
import { insertRow } from "../../support/db-seed";

describe("S7 D9.7 D20.1 D20.5: audited_events e o dono do lease da outbox", () => {
  let app: Client;

  beforeAll(async () => {
    app = await connect("app");
  });

  afterAll(async () => {
    await app.end();
  });

  const auditedRow = (overrides: Record<string, string | number | boolean | Date | null> = {}) => ({
    event_id: newId(),
    event_type: "WalletBalanceChanged",
    aggregate_id: newId(),
    wallet_id: newId(),
    wallet_version: 2,
    in_order: true,
    occurred_at: new Date(),
    audited_at: new Date(),
    ...overrides,
  });

  it("D20.1: a app grava em audited_events; a ordem de chegada é gerada pelo banco", async () => {
    const first = auditedRow();
    const second = auditedRow();
    await insertRow(app, "audited_events", first);
    await insertRow(app, "audited_events", second);

    const { rows } = await app.query<{ event_id: string }>(
      "SELECT event_id FROM audited_events WHERE event_id = ANY($1) ORDER BY arrival",
      [[first.event_id, second.event_id]],
    );
    expect(rows.map((row) => row.event_id)).toEqual([first.event_id, second.event_id]);
  });

  it("D9.7 D20.1: o mesmo eventId duas vezes → PK", async () => {
    const row = auditedRow();
    await insertRow(app, "audited_events", row);

    await expectDbError(insertRow(app, "audited_events", row), {
      code: "23505",
      constraint: "audited_events_pk",
    });
  });

  it("D20.1: in_order só existe com wallet_version, e wallet_version só com wallet_id", async () => {
    await insertRow(app, "audited_events", auditedRow({ wallet_version: null, in_order: null }));
    await insertRow(app, "audited_events", auditedRow({ wallet_id: null, wallet_version: null, in_order: null }));

    await expectDbError(insertRow(app, "audited_events", auditedRow({ in_order: null })), {
      code: "23514",
      constraint: "audited_events_in_order_ck",
    });
    await expectDbError(insertRow(app, "audited_events", auditedRow({ wallet_version: null })), {
      code: "23514",
      constraint: "audited_events_in_order_ck",
    });
    await expectDbError(insertRow(app, "audited_events", auditedRow({ wallet_id: null })), {
      code: "23514",
      constraint: "audited_events_version_wallet_ck",
    });
  });

  it("D7.3 D20.1: audited_events não aceita UPDATE nem DELETE do papel da app", async () => {
    const row = auditedRow();
    await insertRow(app, "audited_events", row);

    await expectDbError(
      app.query("UPDATE audited_events SET in_order = false WHERE event_id = $1", [row.event_id]),
      { code: "42501" },
    );
    await expectDbError(app.query("DELETE FROM audited_events WHERE event_id = $1", [row.event_id]), {
      code: "42501",
    });
  });

  it("D20.5: a app grava o dono do lease na outbox", async () => {
    const walletId = newId();
    const id = newId();
    await insertRow(app, "outbox_messages", {
      id,
      aggregate_id: walletId,
      ordering_key: walletId,
      event_type: "WalletOpened",
      payload: JSON.stringify({ eventId: id }),
      occurred_at: new Date(),
      next_attempt_at: new Date(),
      // Já publicado: não entra no backlog do publisher dos outros testes (D20.8).
      published_at: new Date(),
    });
    const owner = newId();

    await app.query("UPDATE outbox_messages SET locked_by = $2 WHERE id = $1", [id, owner]);

    const { rows } = await app.query<{ locked_by: string }>("SELECT locked_by FROM outbox_messages WHERE id = $1", [id]);
    expect(rows[0]?.locked_by).toBe(owner);
  });
});

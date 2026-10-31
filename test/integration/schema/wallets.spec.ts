import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Client } from "pg";
import { expectLedgerMatchesBalances } from "../../support/db-ledger-invariant";
import { connect, expectDbError } from "../../support/db";
import { insertRow, seedWallet, walletRow } from "../../support/db-seed";

describe("S2 R-05-09 D7.3: garantias da tabela wallets (papel da app)", () => {
  let app: Client;

  beforeAll(async () => {
    app = await connect("app");
  });

  afterAll(async () => {
    await expectLedgerMatchesBalances();
    await app.end();
  });

  it("R-05-09 R-06-25 D7.3: saldo negativo → CHECK", async () => {
    await expectDbError(
      insertRow(app, "wallets", walletRow({ balance: "-0.01" })),
      { code: "23514", constraint: "wallets_balance_non_negative_ck" },
    );
  });

  it("R-05-09 D7.3: UPDATE para saldo negativo → CHECK", async () => {
    const wallet = await seedWallet(app);

    await expectDbError(
      app.query("UPDATE wallets SET balance = -1 WHERE id = $1", [wallet.id]),
      { code: "23514", constraint: "wallets_balance_non_negative_ck" },
    );
  });

  it("D15.2 D2.4: saldo com 16 dígitos inteiros → CHECK do teto", async () => {
    await expectDbError(
      insertRow(app, "wallets", walletRow({ balance: "1000000000000000.00" })),
      { code: "23514", constraint: "wallets_balance_limit_ck" },
    );
  });

  it("D2.5: moeda fora do formato ISO → CHECK", async () => {
    await expectDbError(
      insertRow(app, "wallets", walletRow({ currency: "brl" })),
      { code: "23514", constraint: "wallets_currency_format_ck" },
    );
  });

  it("R-06-22 D7.3: duas wallets iguais (player, moeda) → UNIQUE", async () => {
    const wallet = await seedWallet(app);

    await expectDbError(
      insertRow(app, "wallets", walletRow({ player_id: wallet.playerId })),
      { code: "23505", constraint: "wallets_player_currency_uq" },
    );
  });

  it("R-06-22 D2.5: o mesmo player pode ter uma wallet por moeda", async () => {
    const wallet = await seedWallet(app);

    await insertRow(
      app,
      "wallets",
      walletRow({ player_id: wallet.playerId, currency: "USD" }),
    );
    const { rows } = await app.query(
      "SELECT count(*)::int AS n FROM wallets WHERE player_id = $1",
      [wallet.playerId],
    );
    expect(rows[0].n).toBe(2);
  });

  it("D15.1: wallet nova com saldo e sem lançamento → erro no COMMIT", async () => {
    await app.query("BEGIN");
    await insertRow(app, "wallets", walletRow({ balance: "10.00" }));

    await expectDbError(app.query("COMMIT"), {
      code: "23000",
      constraint: "wallets_ledger_tail",
    });
  });
});

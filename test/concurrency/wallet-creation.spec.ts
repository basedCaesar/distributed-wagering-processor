import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Client } from "pg";
import {
  type ErrorBody,
  newPlayerId,
  startTestApi,
  type TestApi,
  type WalletBody,
} from "../support/api";
import { connect, withClient } from "../support/db";
import { expectLedgerMatchesBalances } from "../support/db-ledger-invariant";
import { insertRow, walletRow } from "../support/db-seed";
import { waitForWaiterOn } from "../support/pg-locks";

const PARALLEL = 20;

let api: TestApi;
let observer: Client;

beforeAll(async () => {
  api = await startTestApi();
  observer = await connect("app");
});

afterAll(async () => {
  await api.close();
  await observer.end();
  await expectLedgerMatchesBalances();
});

const body = (playerId: string) => ({
  playerId,
  initialBalance: { amount: "100.00", currency: "BRL" },
});

async function countsFor(playerId: string) {
  return withClient("app", async (client) => {
    const { rows } = await client.query(
      `SELECT (SELECT count(*)::int FROM wallets WHERE player_id = $1) AS wallets,
              (SELECT count(*)::int FROM wager_transactions WHERE player_id = $1) AS transactions`,
      [playerId],
    );
    return rows[0];
  });
}

/**
 * Uma transação crua (papel da app) grava a wallet e **não** commita; o
 * `POST /wallets` igual fica parado no `UNIQUE (player_id, currency)`,
 * confirmado por `pg_locks`. Quem decide o desfecho é o teste.
 */
async function withRivalHoldingWallet(
  playerId: string,
  decide: (ctx: {
    rival: Client;
    rivalWalletId: string;
    pending: Promise<Response>;
  }) => Promise<void>,
): Promise<void> {
  const rival = await connect("app");
  try {
    await rival.query("BEGIN");
    const row = walletRow({ player_id: playerId, currency: "BRL" });
    await insertRow(rival, "wallets", row);
    const { rows } = await rival.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    );
    const rivalPid = rows[0]?.pid as number;

    const pending = api.request("POST", "/wallets", { body: body(playerId) });
    await waitForWaiterOn(observer, rivalPid);

    await decide({ rival, rivalWalletId: row.id as string, pending });
  } finally {
    // Sem efeito se o caso já fez COMMIT ou ROLLBACK.
    await rival.query("ROLLBACK");
    await rival.end();
  }
}

describe("S3 R-09-05 D6.3: criação de wallet concorrente", () => {
  it("R-09-05 D6.3: POST parado no índice único; a rival commita → 409 WALLET_ALREADY_EXISTS com o id dela", async () => {
    const playerId = newPlayerId();

    await withRivalHoldingWallet(playerId, async ({ rival, rivalWalletId, pending }) => {
      await rival.query("COMMIT");

      const response = await pending;
      const error = (await response.json()) as ErrorBody;

      expect(response.status).toBe(409);
      expect(error.error).toMatchObject({
        code: "WALLET_ALREADY_EXISTS",
        details: { walletId: rivalWalletId },
      });
    });
    // O POST foi desfeito inteiro: nem OPENING nem lançamento dele.
    expect(await countsFor(playerId)).toEqual({ wallets: 1, transactions: 0 });
  });

  it("D5 D7.2 D16.3: POST parado no índice único além do lock_timeout → 503 TEMPORARILY_UNAVAILABLE com Retry-After: 1", async () => {
    const playerId = newPlayerId();

    await withRivalHoldingWallet(playerId, async ({ rival, pending }) => {
      const response = await pending;
      const error = (await response.json()) as ErrorBody;
      await rival.query("ROLLBACK");

      expect({
        status: response.status,
        retryAfter: response.headers.get("retry-after"),
        code: error.error.code,
      }).toEqual({ status: 503, retryAfter: "1", code: "TEMPORARILY_UNAVAILABLE" });
    });
    expect(await countsFor(playerId)).toEqual({ wallets: 0, transactions: 0 });
  });

  it(`R-09-05 R-06-22 D6.3: ${PARALLEL} POST /wallets iguais em paralelo → 1×201 e ${PARALLEL - 1}×409, todos com o mesmo walletId`, async () => {
    const playerId = newPlayerId();
    const token = await api.issuer.operatorToken();

    const responses = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        api.request("POST", "/wallets", { token, body: body(playerId) }),
      ),
    );
    const results = await Promise.all(
      responses.map(async (response) => ({
        status: response.status,
        body: (await response.json()) as WalletBody & ErrorBody,
      })),
    );

    const created = results.filter((result) => result.status === 201);
    const conflicts = results.filter((result) => result.status === 409);
    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(PARALLEL - 1);
    const walletId = created[0]?.body.id;
    for (const conflict of conflicts) {
      expect(conflict.body.error).toMatchObject({
        code: "WALLET_ALREADY_EXISTS",
        details: { walletId },
      });
    }
    const counts = await withClient("app", async (client) => {
      const { rows } = await client.query(
        `SELECT (SELECT count(*)::int FROM wallets WHERE player_id = $1) AS wallets,
                (SELECT count(*)::int FROM wager_transactions WHERE player_id = $1) AS openings,
                (SELECT count(*)::int FROM outbox_messages WHERE ordering_key = $2) AS events`,
        [playerId, walletId],
      );
      return rows[0];
    });
    expect(counts).toEqual({ wallets: 1, openings: 1, events: 3 });
  });
});

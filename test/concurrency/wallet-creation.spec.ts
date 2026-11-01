import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  type ErrorBody,
  newPlayerId,
  startTestApi,
  type TestApi,
  type WalletBody,
} from "../support/api";
import { withClient } from "../support/db";
import { expectLedgerMatchesBalances } from "../support/db-ledger-invariant";

const PARALLEL = 20;

let api: TestApi;

beforeAll(async () => {
  api = await startTestApi();
});

afterAll(async () => {
  await api.close();
  await expectLedgerMatchesBalances();
});

describe("S3 R-09-05 D6.3: criação de wallet concorrente", () => {
  it(`R-09-05 R-06-22 D6.3: ${PARALLEL} POST /wallets iguais em paralelo → 1×201 e ${PARALLEL - 1}×409, todos com o mesmo walletId`, async () => {
    const playerId = newPlayerId();
    const token = await api.issuer.operatorToken();
    const body = {
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    };

    const responses = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        api.request("POST", "/wallets", { token, body }),
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

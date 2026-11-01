import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { Client } from "pg";
import type { DuplicateLayer } from "../../src/modules/wagering/application/ports";
import { wageringDuplicatesTotal } from "../../src/shared/metrics/metrics";
import { type ErrorBody, startTestApi, type TestApi } from "../support/api";
import { connect, newId, withClient } from "../support/db";
import { expectLedgerMatchesBalances } from "../support/db-ledger-invariant";
import { insertRow, rejected, transactionRow } from "../support/db-seed";
import { waitForWaiterOn } from "../support/pg-locks";
import {
  brl,
  createWallet,
  eventsAfterOpening,
  holdWalletLock,
  submit,
  type TestWallet,
  waitForWalletLockWaiters,
  wagerBody,
} from "../support/wagering";

/** Pool padrão do `pg` por processo (D17.5). */
const POOL_SIZE = 10;
const PARALLEL = 50;

let api: TestApi;
let observer: Client;

beforeAll(async () => {
  api = await startTestApi();
  observer = await connect("app");
});

// Todo teste que move dinheiro termina com o invariante (CLAUDE.md, D11.4).
afterEach(async () => {
  await expectLedgerMatchesBalances();
});

afterAll(async () => {
  await api.close();
  await observer.end();
});

async function ledgerOf(walletId: string) {
  return withClient("app", async (client) => {
    const wallet = await client.query(
      "SELECT balance::text AS balance, version FROM wallets WHERE id = $1",
      [walletId],
    );
    const debits = await client.query(
      `SELECT count(*)::int AS n FROM wallet_ledger_entries
        WHERE wallet_id = $1 AND direction = 'DEBIT'`,
      [walletId],
    );
    return { ...wallet.rows[0], debits: debits.rows[0].n };
  });
}

/** `wagering_duplicates_total` por camada (D11.2, D17.7); o API roda neste processo. */
async function duplicates(): Promise<Record<DuplicateLayer, number>> {
  const { values } = await wageringDuplicatesTotal.get();
  const of = (layer: DuplicateLayer) =>
    values.find((value) => value.labels.layer === layer)?.value ?? 0;
  return { fast_path: of("fast_path"), lock: of("lock"), unique_index: of("unique_index") };
}

async function duplicatesDuring(work: () => Promise<void>): Promise<Record<DuplicateLayer, number>> {
  const before = await duplicates();
  await work();
  const after = await duplicates();
  return {
    fast_path: after.fast_path - before.fast_path,
    lock: after.lock - before.lock,
    unique_index: after.unique_index - before.unique_index,
  };
}

/**
 * Trava a wallet numa transação crua, dispara as submissões e só solta
 * quando `waiters` sessões aparecem esperando o lock **dessa** wallet no
 * `pg_locks` (D17.5). Assim a corrida acontece de verdade no lock.
 */
async function raceOnWalletLock<T>(
  walletId: string,
  waiters: number,
  fire: () => Promise<T>[],
): Promise<T[]> {
  const lock = await holdWalletLock(walletId);
  try {
    const pending = fire();
    await waitForWalletLockWaiters(observer, lock, waiters);
    await lock.release();
    return await Promise.all(pending);
  } finally {
    await lock.release();
  }
}

describe("S4 R-13-C1..C3 D3.6 D7.2: submissão concorrente", () => {
  it(`R-13-C1 D3.6 D17.5 D17.7: ${PARALLEL} BETs iguais em paralelo, com as ${POOL_SIZE} conexões do pool esperando o lock → 1 débito e ${PARALLEL - 1} replays, todos 200, nenhum pelo UNIQUE`, async () => {
    const wallet = await createWallet(api, brl("1000.00"));
    const body = wagerBody(wallet, { money: brl("25.00") });
    const token = await api.issuer.providerToken(body.providerId);

    let results: Awaited<ReturnType<typeof submit>>[] = [];
    const counted = await duplicatesDuring(async () => {
      results = await raceOnWalletLock(wallet.id, POOL_SIZE, () =>
        Array.from({ length: PARALLEL }, () => submit(api, body, { token })),
      );
    });

    expect(results.map((result) => result.status)).toEqual(Array(PARALLEL).fill(200));
    const originals = results.filter((result) => !result.body.idempotentReplay);
    expect(originals).toHaveLength(1);
    const transactionId = originals[0]?.body.transactionId;
    for (const result of results) {
      expect(result.body).toMatchObject({
        transactionId,
        status: "PROCESSED",
        balance: brl("975.00"),
      });
    }
    expect(await ledgerOf(wallet.id)).toEqual({ balance: "975.00", version: 2, debits: 1 });
    // A checagem autoritativa sob o lock pegou as duplicatas; o UNIQUE,
    // nenhuma. Checar antes do lock poria as que esperavam no índice (D3.6).
    expect(counted.unique_index).toBe(0);
    expect(counted.fast_path + counted.lock).toBe(PARALLEL - 1);
    expect(counted.lock).toBeGreaterThanOrEqual(POOL_SIZE - 1);
  });

  it("R-13-C2 R-08-03 R-08-09: saldo 100.00, duas BETs de 80.00 esperando o mesmo lock → 1 PROCESSED, 1 REJECTED INSUFFICIENT_FUNDS, saldo 20.00, 1 DEBIT", async () => {
    const wallet = await createWallet(api, brl("100.00"));
    const bets = [
      wagerBody(wallet, { money: brl("80.00") }),
      wagerBody(wallet, { money: brl("80.00") }),
    ];

    const results = await raceOnWalletLock(wallet.id, 2, () =>
      bets.map((bet) => submit(api, bet)),
    );

    const statuses = results.map((result) => result.body.status).sort();
    expect(statuses).toEqual(["PROCESSED", "REJECTED"]);
    const loser = results.find((result) => result.body.status === "REJECTED");
    expect(loser?.status).toBe(422);
    expect(loser?.body).toMatchObject({
      failureCode: "INSUFFICIENT_FUNDS",
      balance: brl("20.00"),
    });
    expect(await ledgerOf(wallet.id)).toEqual({ balance: "20.00", version: 2, debits: 1 });

    // Nenhum retry duplica o débito (R-08-09): as duas reenviadas são replays.
    const retries = await Promise.all(bets.map((bet) => submit(api, bet)));
    expect(retries.map((retry) => retry.body.idempotentReplay)).toEqual([true, true]);
    expect(await ledgerOf(wallet.id)).toEqual({ balance: "20.00", version: 2, debits: 1 });
  });

  it("D1.1 D1.3 D7.2: REFUND e ROLLBACK da mesma BET esperando o mesmo lock → 1 PROCESSED, 1 REFERENCE_ALREADY_REVERSED, nenhum 500", async () => {
    const wallet = await createWallet(api, brl("100.00"));
    const bet = wagerBody(wallet, { money: brl("40.00") });
    expect((await submit(api, bet)).status).toBe(200);
    const reversals = (["REFUND", "ROLLBACK"] as const).map((kind) =>
      wagerBody(wallet, {
        kind,
        money: brl("40.00"),
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );

    const results = await raceOnWalletLock(wallet.id, 2, () =>
      reversals.map((reversal) => submit(api, reversal)),
    );

    expect(results.map((result) => result.status).sort()).toEqual([200, 422]);
    const loser = results.find((result) => result.status === 422);
    expect(loser?.body).toMatchObject({
      status: "REJECTED",
      failureCode: "REFERENCE_ALREADY_REVERSED",
      balance: brl("100.00"),
    });
    // Um crédito só: a BET foi revertida uma vez (D1.1).
    expect(await ledgerOf(wallet.id)).toMatchObject({ balance: "100.00", version: 3 });
  });

  it("R-13-C3 R-08-05 R-05-06: com a wallet A travada (confirmado por pg_locks), a submissão na wallet B conclui", async () => {
    const walletA = await createWallet(api, brl("100.00"));
    const walletB = await createWallet(api, brl("100.00"));

    const lock = await holdWalletLock(walletA.id);
    try {
      const blocked = submit(api, wagerBody(walletA, { money: brl("10.00") }));
      await waitForWalletLockWaiters(observer, lock, 1);

      const other = await submit(api, wagerBody(walletB, { money: brl("10.00") }));

      expect(other.status).toBe(200);
      expect(other.body.balance).toEqual(brl("90.00"));
      await lock.release();
      expect((await blocked).status).toBe(200);
    } finally {
      await lock.release();
    }
  });

  it("fumaça (não prova o R-13-C3, provado pelo teste da wallet A travada): 10 wallets × 3 BETs em paralelo, sem sincronização → cada uma com seus débitos", async () => {
    const wallets: TestWallet[] = await Promise.all(
      Array.from({ length: 10 }, () => createWallet(api, brl("100.00"))),
    );

    const results = await Promise.all(
      wallets.flatMap((wallet) =>
        [1, 2, 3].map(() => submit(api, wagerBody(wallet, { money: brl("10.00") }))),
      ),
    );

    expect(results.every((result) => result.status === 200)).toBe(true);
    for (const wallet of wallets) {
      expect(await ledgerOf(wallet.id)).toEqual({ balance: "70.00", version: 4, debits: 3 });
    }
  });

  it("D3.6 D17.2 D17.7: mesma key em duas wallets ao mesmo tempo → o UNIQUE barra a segunda, o use case repete e devolve 409 IDEMPOTENCY_KEY_CONFLICT", async () => {
    const walletA = await createWallet(api, brl("100.00"));
    const walletB = await createWallet(api, brl("100.00"));
    const body = wagerBody(walletA, { money: brl("10.00") });
    const key = `provider-a:${body.externalTransactionId}`;

    // A rival grava a mesma key na wallet B e segura o commit.
    const rival = await connect("app");
    let counted: Record<DuplicateLayer, number> | undefined;
    try {
      await rival.query("BEGIN");
      const rivalRow = transactionRow(
        { id: walletB.id, playerId: walletB.playerId, currency: "BRL" },
        {
          ...rejected,
          provider_id: "provider-a",
          idempotency_key: key,
          external_transaction_id: `rival-${newId()}`,
          balance_after: "100.00",
        },
      );
      await insertRow(rival, "wager_transactions", rivalRow);
      const { rows } = await rival.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");

      let result: { status: number; body: ErrorBody } | undefined;
      counted = await duplicatesDuring(async () => {
        const pending = submit(api, body, { key });
        await waitForWaiterOn(observer, rows[0]?.pid as number);
        await rival.query("COMMIT");
        result = (await pending) as unknown as { status: number; body: ErrorBody };
      });

      expect(result?.status).toBe(409);
      expect(result?.body.error).toMatchObject({
        code: "IDEMPOTENCY_KEY_CONFLICT",
        details: { transactionId: rivalRow.id },
      });
    } finally {
      await rival.query("ROLLBACK");
      await rival.end();
    }
    expect(counted).toEqual({ fast_path: 0, lock: 0, unique_index: 1 });
    // A submissão foi desfeita inteira: nem débito nem evento na wallet A.
    expect(await ledgerOf(walletA.id)).toEqual({ balance: "100.00", version: 1, debits: 0 });
    expect(await eventsAfterOpening(walletA.id)).toEqual([]);
  });

  it("D5 D7.2 D16.3: lock da wallet além do lock_timeout → 503 TEMPORARILY_UNAVAILABLE com Retry-After: 1, nada gravado", async () => {
    const wallet = await createWallet(api, brl("100.00"));
    const body = wagerBody(wallet, { money: brl("10.00") });

    const lock = await holdWalletLock(wallet.id);
    let result: { status: number; body: ErrorBody; headers: Headers };
    try {
      const pending = submit(api, body);
      await waitForWalletLockWaiters(observer, lock, 1);
      result = (await pending) as unknown as typeof result;
    } finally {
      await lock.release();
    }

    expect({
      status: result.status,
      retryAfter: result.headers.get("retry-after"),
      code: result.body.error.code,
    }).toEqual({ status: 503, retryAfter: "1", code: "TEMPORARILY_UNAVAILABLE" });
    expect(await ledgerOf(wallet.id)).toEqual({ balance: "100.00", version: 1, debits: 0 });
    expect(await eventsAfterOpening(wallet.id)).toEqual([]);

    // Reenviar depois do 503 aplica uma vez só.
    const retry = await submit(api, body);
    expect(retry).toMatchObject({ status: 200, body: { idempotentReplay: false } });
  });
});

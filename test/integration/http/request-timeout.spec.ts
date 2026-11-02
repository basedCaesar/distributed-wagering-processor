import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { loadConfig } from "../../../src/shared/config/config";
import { APP_CONFIG } from "../../../src/shared/config/config.module";
import { type ErrorBody, startTestApi, type TestApi } from "../../support/api";
import { effectsOf } from "../../support/consumer";
import { connect } from "../../support/db";
import { expectLedgerMatchesBalances } from "../../support/db-ledger-invariant";
import { waitFor, walletLockWaiterApps } from "../../support/processes";
import { brl, createWallet, holdWalletLock, submit, waitForWalletLockWaiters, wagerBody } from "../../support/wagering";

/**
 * Prazo de 1 s no teste (D21.3): abaixo do `lock_timeout` de 2 s (D5),
 * então uma submissão parada no lock da wallet estoura o prazo da
 * requisição antes de o banco desistir.
 */
const REQUEST_TIMEOUT_MS = 1000;

let api: TestApi;

beforeEach(async () => {
  const config = loadConfig();
  api = await startTestApi({
    overrides: [{ provide: APP_CONFIG, useValue: { ...config, http: { requestTimeoutMs: REQUEST_TIMEOUT_MS } } }],
  });
});

afterEach(async () => {
  await api.close();
});

describe("D5 D21.3: prazo da requisição HTTP", () => {
  it("D5 D21.3 D16.3: requisição além do prazo → 503 TEMPORARILY_UNAVAILABLE com Retry-After: 1; nada gravado; o reenvio com a mesma key processa", async () => {
    const wallet = await createWallet(api, brl("100.00"));
    const body = wagerBody(wallet, { money: brl("10.00") });
    const lock = await holdWalletLock(wallet.id);
    const observer = await connect("app");
    let late: Awaited<ReturnType<typeof submit>>;
    let elapsed: number;
    try {
      const started = performance.now();
      const pending = submit(api, body);
      await waitForWalletLockWaiters(observer, lock, 1);
      late = await pending;
      elapsed = performance.now() - started;
      // O banco desiste no lock_timeout (o waiter some do pg_locks) e desfaz a transação.
      await waitFor(async () => (await walletLockWaiterApps(observer, lock)).length === 0, "o lock_timeout da submissão", 5000);
    } finally {
      await lock.release();
      await observer.end();
    }

    expect(late.status).toBe(503);
    expect(late.headers.get("retry-after")).toBe("1");
    expect((late.body as unknown as ErrorBody).error.code).toBe("TEMPORARILY_UNAVAILABLE");
    // Respondeu no prazo da requisição, antes do lock_timeout de 2 s.
    expect(elapsed).toBeLessThan(2000);
    expect((await effectsOf(body.providerId, body.externalTransactionId)).transactions).toEqual([]);

    const again = await submit(api, body);
    expect(again.status).toBe(200);
    expect(again.body.idempotentReplay).toBe(false);
    await expectLedgerMatchesBalances();
  });

  it("D21.3 D3.4: o trabalho não é cancelado pelo 503; se ele commita depois, o reenvio com a mesma key é replay", async () => {
    const wallet = await createWallet(api, brl("100.00"));
    const body = wagerBody(wallet, { money: brl("10.00") });
    const lock = await holdWalletLock(wallet.id);
    const observer = await connect("app");
    let late: Awaited<ReturnType<typeof submit>>;
    try {
      const pending = submit(api, body);
      await waitForWalletLockWaiters(observer, lock, 1);
      late = await pending;
    } finally {
      // Solto logo depois do 503, antes do lock_timeout: a submissão segue e commita.
      await lock.release();
      await observer.end();
    }
    expect(late.status).toBe(503);
    await waitFor(
      async () => (await effectsOf(body.providerId, body.externalTransactionId)).transactions.length === 1,
      "a submissão commitar depois do 503",
      5000,
    );

    const again = await submit(api, body);
    expect(again.status).toBe(200);
    expect(again.body.idempotentReplay).toBe(true);
    expect((await effectsOf(body.providerId, body.externalTransactionId)).entries).toHaveLength(1);
    await expectLedgerMatchesBalances();
  });

  it("D21.3: uma requisição dentro do prazo não é afetada", async () => {
    const wallet = await createWallet(api, brl("100.00"));
    const response = await submit(api, wagerBody(wallet, { money: brl("10.00") }));
    expect(response.status).toBe(200);
    expect(response.headers.get("retry-after")).toBeNull();
    await expectLedgerMatchesBalances();
  });
});

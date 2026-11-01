import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
  type ErrorBody,
  newPlayerId,
  startTestApi,
  type TestApi,
  type WalletBody,
} from "../../support/api";
import { withClient } from "../../support/db";
import { expectLedgerMatchesBalances } from "../../support/db-ledger-invariant";

let api: TestApi;

beforeAll(async () => {
  api = await startTestApi();
});

// Todo teste que move dinheiro termina com o invariante (CLAUDE.md, D11.4).
afterEach(async () => {
  await expectLedgerMatchesBalances();
});

afterAll(async () => {
  await api.close();
});

const createWallet = (body: unknown) =>
  api.request("POST", "/wallets", { body });

const brl = (amount: string) => ({ amount, currency: "BRL" });

async function rowsOf(walletId: string) {
  return withClient("app", async (client) => {
    const transactions = await client.query(
      `SELECT kind, status, amount::text AS amount, currency, provider_id,
              balance_after::text AS balance_after, correlation_id
         FROM wager_transactions WHERE wallet_id = $1`,
      [walletId],
    );
    const entries = await client.query(
      `SELECT direction, amount::text AS amount, balance_before::text AS balance_before,
              balance_after::text AS balance_after, wallet_version
         FROM wallet_ledger_entries WHERE wallet_id = $1 ORDER BY wallet_version`,
      [walletId],
    );
    const outbox = await client.query(
      `SELECT event_type, aggregate_id, ordering_key, payload
         FROM outbox_messages WHERE ordering_key = $1 ORDER BY position`,
      [walletId],
    );
    return {
      transactions: transactions.rows,
      entries: entries.rows,
      outbox: outbox.rows,
    };
  });
}

describe("S3 R-09-02..05 D6.2 D6.3: POST /wallets", () => {
  it("R-09-02 R-09-04 D6.2: 1000.00 → 201, version 1, OPENING PROCESSED com CREDIT v1", async () => {
    const playerId = newPlayerId();

    const response = await createWallet({
      playerId,
      initialBalance: brl("1000.00"),
    });
    const body = (await response.json()) as WalletBody;

    expect(response.status).toBe(201);
    expect(body).toEqual({
      id: expect.any(String),
      playerId,
      balance: brl("1000.00"),
      version: 1,
    });
    const { transactions, entries } = await rowsOf(body.id);
    expect(transactions).toEqual([
      {
        kind: "OPENING",
        status: "PROCESSED",
        amount: "1000.00",
        currency: "BRL",
        provider_id: null,
        balance_after: "1000.00",
        correlation_id: expect.any(String),
      },
    ]);
    expect(entries).toEqual([
      {
        direction: "CREDIT",
        amount: "1000.00",
        balance_before: "0.00",
        balance_after: "1000.00",
        wallet_version: 1,
      },
    ]);
  });

  it("D6.2 D2.3 D2.1: saldo inicial 0 → 201, version 1, sem OPENING nem lançamento; \"0\" vira \"0.00\"", async () => {
    const response = await createWallet({
      playerId: newPlayerId(),
      initialBalance: brl("0"),
    });
    const body = (await response.json()) as WalletBody;

    expect(response.status).toBe(201);
    expect(body.balance).toEqual(brl("0.00"));
    expect(body.version).toBe(1);
    const { transactions, entries } = await rowsOf(body.id);
    expect(transactions).toEqual([]);
    expect(entries).toEqual([]);
  });

  it("R-09-03 D9.4 D6.2 D9.3: outbox com WalletOpened, WagerTransactionProcessed e WalletBalanceChanged, em ordem", async () => {
    const response = await createWallet({
      playerId: newPlayerId(),
      initialBalance: brl("50.00"),
    });
    const wallet = (await response.json()) as WalletBody;

    const { outbox, transactions } = await rowsOf(wallet.id);
    expect(outbox.map((row) => row.event_type)).toEqual([
      "WalletOpened",
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
    for (const row of outbox) expect(row.ordering_key).toBe(wallet.id);
    const [opened, processed, changed] = outbox;
    expect(opened.aggregate_id).toBe(wallet.id);
    expect(processed.payload.data).toMatchObject({
      kind: "OPENING",
      walletId: wallet.id,
      money: brl("50.00"),
      balanceAfter: brl("50.00"),
      walletVersion: 1,
    });
    expect(processed.aggregate_id).toBe(processed.payload.data.transactionId);
    expect(changed.payload.data).toMatchObject({
      walletId: wallet.id,
      direction: "CREDIT",
      balanceBefore: brl("0.00"),
      balanceAfter: brl("50.00"),
      walletVersion: 1,
    });
    // §11: envelope completo, com o correlationId da requisição.
    const correlationId = transactions[0]?.correlation_id;
    for (const row of outbox) {
      expect(row.payload).toMatchObject({
        eventId: expect.any(String),
        eventType: row.event_type,
        correlationId,
        causationId: expect.any(String),
        occurredAt: expect.any(String),
        version: 1,
      });
    }
  });

  it("D9.4 D2.3: saldo inicial 0 → só WalletOpened na outbox", async () => {
    const response = await createWallet({
      playerId: newPlayerId(),
      initialBalance: brl("0.00"),
    });
    const wallet = (await response.json()) as WalletBody;

    const { outbox } = await rowsOf(wallet.id);
    expect(outbox.map((row) => row.event_type)).toEqual(["WalletOpened"]);
  });

  it("D9.5 D16.7: X-Correlation-Id válido vai para os eventos e volta na resposta", async () => {
    const correlationId = `corr:${Bun.randomUUIDv7()}`;
    const response = await api.request("POST", "/wallets", {
      body: { playerId: newPlayerId(), initialBalance: brl("1.00") },
      headers: { "x-correlation-id": correlationId },
    });
    const wallet = (await response.json()) as WalletBody;

    expect(response.headers.get("x-correlation-id")).toBe(correlationId);
    const { outbox, transactions } = await rowsOf(wallet.id);
    expect(transactions[0]?.correlation_id).toBe(correlationId);
    for (const row of outbox) expect(row.payload.correlationId).toBe(correlationId);
  });

  it("D16.7: X-Correlation-Id fora do formato é trocado por um gerado", async () => {
    const response = await api.request("POST", "/wallets", {
      body: { playerId: newPlayerId(), initialBalance: brl("1.00") },
      headers: { "x-correlation-id": "tem espaço e {chaves}" },
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("x-correlation-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("R-09-05 D6.3 D16.2: criar de novo (mesmo player e moeda) → 409 WALLET_ALREADY_EXISTS com o walletId", async () => {
    const playerId = newPlayerId();
    const first = await createWallet({ playerId, initialBalance: brl("10.00") });
    const created = (await first.json()) as WalletBody;

    const second = await createWallet({ playerId, initialBalance: brl("99.00") });
    const body = (await second.json()) as ErrorBody;

    expect(second.status).toBe(409);
    expect(body.error.code).toBe("WALLET_ALREADY_EXISTS");
    expect(body.error.details).toEqual({ walletId: created.id });
    const { transactions } = await rowsOf(created.id);
    expect(transactions).toHaveLength(1);
  });

  it("R-06-22: mesmo playerId em outra moeda → 201 (outra wallet)", async () => {
    const playerId = newPlayerId();
    await createWallet({ playerId, initialBalance: brl("10.00") });

    const response = await createWallet({
      playerId,
      initialBalance: { amount: "10.00", currency: "USD" },
    });

    expect(response.status).toBe(201);
  });

  it.each([
    ["3 casas decimais", { initialBalance: brl("10.001") }],
    ["sinal negativo", { initialBalance: brl("-10.00") }],
    ["notação científica", { initialBalance: brl("1e3") }],
    ["amount numérico", { initialBalance: { amount: 10, currency: "BRL" } }],
    ["moeda fora da lista", { initialBalance: { amount: "10.00", currency: "EUR" } }],
    ["moeda minúscula", { initialBalance: { amount: "10.00", currency: "brl" } }],
    ["sem initialBalance", { initialBalance: undefined }],
    ["playerId com espaço", { playerId: "player 1" }],
    ["playerId vazio", { playerId: "" }],
    ["playerId com 129 caracteres", { playerId: "p".repeat(129) }],
  ])("D5 D2.2 D2.5 D6.4 D6.7: %s → 400 VALIDATION_ERROR, nada gravado", async (_, override) => {
    const playerId = newPlayerId();
    const response = await createWallet({
      playerId,
      initialBalance: brl("10.00"),
      ...override,
    });
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    const count = await withClient("app", async (client) => {
      const { rows } = await client.query(
        "SELECT count(*)::int AS n FROM wallets WHERE player_id = $1",
        [playerId],
      );
      return rows[0].n;
    });
    expect(count).toBe(0);
  });

  it("D5: JSON mal formado → 400 VALIDATION_ERROR", async () => {
    const response = await fetch(`${api.baseUrl}/wallets`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await api.issuer.operatorToken()}`,
        "content-type": "application/json",
      },
      body: "{ não é json",
    });
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });
});

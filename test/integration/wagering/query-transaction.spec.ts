import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type ErrorBody, startTestApi, type TestApi } from "../../support/api";
import { withClient } from "../../support/db";
import { expectLedgerMatchesBalances } from "../../support/db-ledger-invariant";
import {
  brl,
  createWallet,
  newExternalId,
  submit,
  type TestWallet,
  type TransactionBody,
  wagerBody,
} from "../../support/wagering";

let api: TestApi;

beforeAll(async () => {
  api = await startTestApi();
});

afterAll(async () => {
  await api.close();
  await expectLedgerMatchesBalances();
});

async function get(path: string, token: string | null) {
  const response = await api.request("GET", path, { token });
  return { status: response.status, body: (await response.json()) as TransactionBody & ErrorBody };
}

const providerA = () => api.issuer.providerToken("provider-a");
const providerB = () => api.issuer.providerToken("provider-b");

async function betOf(wallet: TestWallet, overrides: Record<string, unknown> = {}) {
  const body = wagerBody(wallet, { money: brl("10.00"), ...overrides });
  const { body: response } = await submit(api, body);
  return { body, transactionId: response.transactionId };
}

describe("S4 R-09-08 R-09-09 D5 D10.2: consultas de transação", () => {
  it("R-09-08 D5: GET /wagering/transactions/:id devolve o contrato completo", async () => {
    const wallet = await createWallet(api, brl("100.00"));
    const bet = await betOf(wallet);

    const { status, body } = await get(`/wagering/transactions/${bet.transactionId}`, await providerA());

    expect(status).toBe(200);
    expect(body as TransactionBody).toEqual({
      transactionId: bet.transactionId,
      providerId: "provider-a",
      externalTransactionId: bet.body.externalTransactionId,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: "round-987",
      gameId: "fortune-chimp",
      kind: "BET",
      money: brl("10.00"),
      status: "PROCESSED",
      balance: brl("90.00"),
      createdAt: expect.any(String),
      processedAt: expect.any(String),
    });
  });

  it("R-09-08 D5 D14.6: reversão traz as duas referências; rejeição traz failureCode e não traz processedAt", async () => {
    const wallet = await createWallet(api, brl("100.00"));
    const bet = await betOf(wallet);
    const refund = await betOf(wallet, {
      kind: "REFUND",
      referenceExternalTransactionId: bet.body.externalTransactionId,
    });
    const rejected = await betOf(wallet, { money: brl("500.00") });

    const reversal = await get(`/wagering/transactions/${refund.transactionId}`, await providerA());
    const refusal = await get(`/wagering/transactions/${rejected.transactionId}`, await providerA());

    expect(reversal.body).toMatchObject({
      kind: "REFUND",
      referenceExternalTransactionId: bet.body.externalTransactionId,
      referenceTransactionId: bet.transactionId,
    });
    expect(refusal.body).toMatchObject({
      status: "REJECTED",
      failureCode: "INSUFFICIENT_FUNDS",
      balance: brl("100.00"),
    });
    expect(refusal.body).not.toHaveProperty("processedAt");
  });

  it("R-09-08 D5: pendente sem balance", async () => {
    const wallet = await createWallet(api);
    const pending = await betOf(wallet, {
      kind: "REFUND",
      referenceExternalTransactionId: newExternalId("ausente"),
    });

    const { body } = await get(`/wagering/transactions/${pending.transactionId}`, await providerA());

    expect(body.status).toBe("PENDING_REFERENCE");
    expect(body).not.toHaveProperty("balance");
  });

  it("R-09-09: GET /providers/:providerId/wagering/transactions/:externalTransactionId", async () => {
    const wallet = await createWallet(api);
    const bet = await betOf(wallet);

    const { status, body } = await get(
      `/providers/provider-a/wagering/transactions/${bet.body.externalTransactionId}`,
      await providerA(),
    );

    expect(status).toBe(200);
    expect(body.transactionId).toBe(bet.transactionId);
  });

  it("D10.2: operator consulta transações de qualquer provedor, pelos dois caminhos", async () => {
    const wallet = await createWallet(api);
    const bet = await betOf(wallet);
    const token = await api.issuer.operatorToken();

    const byId = await get(`/wagering/transactions/${bet.transactionId}`, token);
    const byExternal = await get(
      `/providers/provider-a/wagering/transactions/${bet.body.externalTransactionId}`,
      token,
    );

    expect([byId.status, byExternal.status]).toEqual([200, 200]);
  });

  it("D10.2 D5: transação de outro provedor → 404, pelos dois caminhos", async () => {
    const wallet = await createWallet(api);
    const bet = await betOf(wallet);

    const byId = await get(`/wagering/transactions/${bet.transactionId}`, await providerB());
    const byExternal = await get(
      `/providers/provider-a/wagering/transactions/${bet.body.externalTransactionId}`,
      await providerB(),
    );
    const ownRoute = await get(
      `/providers/provider-b/wagering/transactions/${bet.body.externalTransactionId}`,
      await providerB(),
    );

    for (const response of [byId, byExternal, ownRoute]) {
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("NOT_FOUND");
    }
  });

  it("D6.1: a OPENING aparece por id para o operator e é 404 para um provedor", async () => {
    const wallet = await createWallet(api, brl("100.00"));
    const openingId = await withClient("app", async (client) => {
      const { rows } = await client.query(
        "SELECT id FROM wager_transactions WHERE wallet_id = $1 AND kind = 'OPENING'",
        [wallet.id],
      );
      return rows[0].id as string;
    });

    const asOperator = await get(`/wagering/transactions/${openingId}`, await api.issuer.operatorToken());
    const asProvider = await get(`/wagering/transactions/${openingId}`, await providerA());

    expect(asOperator.status).toBe(200);
    expect(asOperator.body).toMatchObject({
      kind: "OPENING",
      providerId: null,
      externalTransactionId: null,
      roundId: null,
      gameId: null,
      balance: brl("100.00"),
    });
    expect(asProvider.status).toBe(404);
  });

  it.each([
    ["transactionId não UUID", "/wagering/transactions/tx-1"],
    ["providerId fora do formato", "/providers/provider%20a/wagering/transactions/tx-1"],
    ["externalTransactionId fora do formato", "/providers/provider-a/wagering/transactions/tem%20espa%C3%A7o"],
  ])("D17.3: %s → 400 VALIDATION_ERROR", async (_, path) => {
    const { status, body } = await get(path, await providerA());

    expect(status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it.each([
    ["por id", () => `/wagering/transactions/${Bun.randomUUIDv7()}`],
    ["por id externo", () => `/providers/provider-a/wagering/transactions/${newExternalId()}`],
  ])("D5: inexistente %s → 404", async (_, path) => {
    const { status } = await get(path(), await providerA());

    expect(status).toBe(404);
  });

  it("D10.1: sem token → 401", async () => {
    const { status } = await get(`/wagering/transactions/${Bun.randomUUIDv7()}`, null);

    expect(status).toBe(401);
  });
});

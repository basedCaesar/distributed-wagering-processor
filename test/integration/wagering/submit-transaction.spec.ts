import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
  type ErrorBody,
  type MoneyJson,
  startTestApi,
  type TestApi,
  type WalletBody,
} from "../../support/api";
import { withClient } from "../../support/db";
import { expectLedgerMatchesBalances } from "../../support/db-ledger-invariant";
import {
  brl,
  createWallet,
  eventsAfterOpening,
  newExternalId,
  type OutboxEventRow,
  type SubmissionInput,
  submit,
  type TestWallet,
  wagerBody,
} from "../../support/wagering";

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

/** Outra wallet do mesmo player, em outra moeda (D6.3). */
async function walletOf(playerId: string, initialBalance: MoneyJson): Promise<TestWallet> {
  const response = await api.request("POST", "/wallets", { body: { playerId, initialBalance } });
  if (response.status !== 201) throw new Error(`POST /wallets devolveu ${response.status}`);
  const wallet = (await response.json()) as WalletBody;
  return { id: wallet.id, playerId: wallet.playerId };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function walletState(walletId: string) {
  return withClient("app", async (client) => {
    const { rows } = await client.query(
      "SELECT balance::text AS balance, version FROM wallets WHERE id = $1",
      [walletId],
    );
    return rows[0];
  });
}

async function transactionRow(transactionId: string) {
  return withClient("app", async (client) => {
    const { rows } = await client.query(
      `SELECT kind, status, amount::text AS amount, currency, provider_id, external_transaction_id,
              idempotency_key, payload_hash, failure_code, failure_detail,
              balance_after::text AS balance_after, balance_after_currency,
              reference_transaction_id, correlation_id,
              (next_attempt_at = created_at) AS due_at_creation
         FROM wager_transactions WHERE id = $1`,
      [transactionId],
    );
    return rows[0];
  });
}

async function entriesOf(transactionId: string) {
  return withClient("app", async (client) => {
    const { rows } = await client.query(
      `SELECT direction, amount::text AS amount, balance_before::text AS balance_before,
              balance_after::text AS balance_after, wallet_version
         FROM wallet_ledger_entries WHERE transaction_id = $1`,
      [transactionId],
    );
    return rows;
  });
}

/** Linhas (transação e eventos) gravadas para um id externo do provedor. */
async function writtenFor(providerId: string, externalTransactionId: string) {
  return withClient("app", async (client) => {
    const { rows } = await client.query(
      `SELECT (SELECT count(*)::int FROM wager_transactions
                WHERE provider_id = $1 AND external_transaction_id = $2) AS transactions,
              (SELECT count(*)::int FROM outbox_messages
                WHERE payload->'data'->>'providerId' = $1
                  AND payload->'data'->>'externalTransactionId' = $2) AS events`,
      [providerId, externalTransactionId],
    );
    return rows[0];
  });
}

async function processed(wallet: TestWallet, overrides: Record<string, unknown>) {
  const body = wagerBody(wallet, overrides);
  const result = await submit(api, body);
  if (result.status !== 200) {
    throw new Error(`esperava 200 para ${String(overrides.kind)}, veio ${result.status}`);
  }
  return { body, result };
}

describe("S4 R-09-10..17: POST /wagering/transactions", () => {
  it("R-09-10 R-09-11 D3.5: corpo do §9 (BET 25.00 numa wallet de 1000.00) → 200 PROCESSED, balance 975.00, idempotentReplay false", async () => {
    const wallet = await createWallet(api, brl("1000.00"));
    const body = wagerBody(wallet);

    const { status, body: response } = await submit(api, body);

    expect(status).toBe(200);
    expect(response).toEqual({
      transactionId: expect.stringMatching(UUID),
      status: "PROCESSED",
      balance: brl("975.00"),
      idempotentReplay: false,
    });
    expect(await walletState(wallet.id)).toEqual({ balance: "975.00", version: 2 });
    expect(await transactionRow(response.transactionId)).toMatchObject({
      kind: "BET",
      status: "PROCESSED",
      amount: "25.00",
      provider_id: "provider-a",
      external_transaction_id: body.externalTransactionId,
      idempotency_key: `provider-a:${body.externalTransactionId}`,
      payload_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      balance_after: "975.00",
      correlation_id: expect.any(String),
    });
    expect(await entriesOf(response.transactionId)).toEqual([
      {
        direction: "DEBIT",
        amount: "25.00",
        balance_before: "1000.00",
        balance_after: "975.00",
        wallet_version: 2,
      },
    ]);
  });

  it("R-07-01..05 R-07-08 R-06-43: BET, WIN, LOSS 0.00, REFUND e ROLLBACK de WIN aplicados com saldo e ledger corretos", async () => {
    const wallet = await createWallet(api, brl("100.00"));

    const bet = await processed(wallet, { kind: "BET", money: brl("30.00") });
    expect(bet.result.body.balance).toEqual(brl("70.00"));

    const win = await processed(wallet, {
      kind: "WIN",
      money: brl("50.00"),
      referenceExternalTransactionId: bet.body.externalTransactionId,
    });
    expect(win.result.body.balance).toEqual(brl("120.00"));
    expect((await transactionRow(win.result.body.transactionId)).reference_transaction_id).toBe(
      bet.result.body.transactionId,
    );

    const loss = await processed(wallet, {
      kind: "LOSS",
      money: brl("0.00"),
      referenceExternalTransactionId: bet.body.externalTransactionId,
    });
    expect(loss.result.body.balance).toEqual(brl("120.00"));
    expect(await entriesOf(loss.result.body.transactionId)).toEqual([]);

    const secondBet = await processed(wallet, { kind: "BET", money: brl("20.00") });
    const refund = await processed(wallet, {
      kind: "REFUND",
      money: brl("20.00"),
      referenceExternalTransactionId: secondBet.body.externalTransactionId,
    });
    expect(refund.result.body.balance).toEqual(brl("120.00"));
    expect(await entriesOf(refund.result.body.transactionId)).toMatchObject([
      { direction: "CREDIT", amount: "20.00" },
    ]);

    const rollback = await processed(wallet, {
      kind: "ROLLBACK",
      money: brl("50.00"),
      referenceExternalTransactionId: win.body.externalTransactionId,
    });
    expect(rollback.result.body.balance).toEqual(brl("70.00"));
    expect(await entriesOf(rollback.result.body.transactionId)).toMatchObject([
      { direction: "DEBIT", amount: "50.00" },
    ]);

    // LOSS não mexe na version (R-06-27): BET, WIN, BET, REFUND, ROLLBACK.
    expect(await walletState(wallet.id)).toEqual({ balance: "70.00", version: 6 });
  });

  it("R-11-04 R-11-06 D9.3 D9.4 D9.5: PROCESSED → WagerTransactionProcessed e WalletBalanceChanged, com orderingKey e correlationId da requisição", async () => {
    const wallet = await createWallet(api, brl("100.00"));
    const correlationId = `corr:${Bun.randomUUIDv7()}`;

    const { body } = await submit(api, wagerBody(wallet, { money: brl("10.00") }), {
      headers: { "x-correlation-id": correlationId },
    });

    const events = await eventsAfterOpening(wallet.id);
    expect(events.map((event) => event.event_type)).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
    const [txEvent, balanceEvent] = events as [OutboxEventRow, OutboxEventRow];
    expect(txEvent.aggregate_id).toBe(body.transactionId);
    expect(balanceEvent.aggregate_id).toBe(wallet.id);
    for (const event of events) {
      expect(event.ordering_key).toBe(wallet.id);
      expect(event.payload.correlationId).toBe(correlationId);
    }
    expect(txEvent.payload.data).toMatchObject({
      transactionId: body.transactionId,
      kind: "BET",
      money: brl("10.00"),
      balanceAfter: brl("90.00"),
      walletVersion: 2,
    });
    expect(txEvent.payload.data).not.toHaveProperty("playerId");
    expect(balanceEvent.payload.data).toMatchObject({
      direction: "DEBIT",
      balanceBefore: brl("100.00"),
      balanceAfter: brl("90.00"),
      walletVersion: 2,
    });
    expect((await transactionRow(body.transactionId)).correlation_id).toBe(correlationId);
  });

  it("R-11-04 R-11-06: LOSS → só WagerTransactionProcessed, sem WalletBalanceChanged", async () => {
    const wallet = await createWallet(api, brl("100.00"));

    await submit(api, wagerBody(wallet, { kind: "LOSS", money: brl("0.00") }));

    const events = await eventsAfterOpening(wallet.id);
    expect(events.map((event) => event.event_type)).toEqual(["WagerTransactionProcessed"]);
  });

  it("R-08-09 R-07-11 R-11-05 D5 D3.5: BET sem saldo → 422 REJECTED INSUFFICIENT_FUNDS com o saldo observado, sem lançamento, evento WagerTransactionRejected", async () => {
    const wallet = await createWallet(api, brl("100.00"));

    const { status, body } = await submit(api, wagerBody(wallet, { money: brl("100.01") }));

    expect(status).toBe(422);
    expect(body).toEqual({
      transactionId: expect.stringMatching(UUID),
      status: "REJECTED",
      failureCode: "INSUFFICIENT_FUNDS",
      balance: brl("100.00"),
      idempotentReplay: false,
    });
    expect(await entriesOf(body.transactionId)).toEqual([]);
    expect(await walletState(wallet.id)).toEqual({ balance: "100.00", version: 1 });
    expect(await transactionRow(body.transactionId)).toMatchObject({
      status: "REJECTED",
      failure_code: "INSUFFICIENT_FUNDS",
      balance_after: "100.00",
    });
    const events = await eventsAfterOpening(wallet.id);
    expect(events.map((event) => event.event_type)).toEqual(["WagerTransactionRejected"]);
    expect(events[0]?.payload.data).toMatchObject({ failureCode: "INSUFFICIENT_FUNDS" });
  });

  it("R-06-26 D5 D15.8: moeda diferente da wallet → 422 CURRENCY_MISMATCH, saldo observado na moeda da wallet", async () => {
    const wallet = await createWallet(api, brl("100.00"));

    const { status, body } = await submit(
      api,
      wagerBody(wallet, { money: { amount: "10.00", currency: "USD" } }),
    );

    expect(status).toBe(422);
    expect(body).toMatchObject({ failureCode: "CURRENCY_MISMATCH", balance: brl("100.00") });
    expect(await transactionRow(body.transactionId)).toMatchObject({
      currency: "USD",
      balance_after_currency: "BRL",
    });
  });

  it("D5 D14.2: wallet de outro playerId → 422 WALLET_PLAYER_MISMATCH", async () => {
    const wallet = await createWallet(api);

    const { status, body } = await submit(api, wagerBody(wallet, { playerId: "outro-player" }));

    expect(status).toBe(422);
    expect(body.failureCode).toBe("WALLET_PLAYER_MISMATCH");
  });

  it("R-07-07 D14.3: referência de outra rodada → 422 REFERENCE_SCOPE_MISMATCH com failureDetail ROUND, também no replay", async () => {
    const wallet = await createWallet(api);
    const bet = await processed(wallet, { money: brl("10.00") });
    const refund = wagerBody(wallet, {
      kind: "REFUND",
      money: brl("10.00"),
      roundId: "outra-rodada",
      referenceExternalTransactionId: bet.body.externalTransactionId,
    });

    const first = await submit(api, refund);
    const replay = await submit(api, refund);

    expect(first.status).toBe(422);
    expect(first.body).toMatchObject({
      failureCode: "REFERENCE_SCOPE_MISMATCH",
      failureDetail: "ROUND",
    });
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  it("R-07-07 D14.2 D14.3: referência de outra wallet do mesmo player → 422 REFERENCE_SCOPE_MISMATCH com failureDetail WALLET", async () => {
    const brlWallet = await createWallet(api, brl("100.00"));
    const usdWallet = await walletOf(brlWallet.playerId, { amount: "100.00", currency: "USD" });
    const bet = await processed(brlWallet, { money: brl("10.00") });

    const { status, body } = await submit(
      api,
      wagerBody(usdWallet, {
        kind: "REFUND",
        money: { amount: "10.00", currency: "USD" },
        referenceExternalTransactionId: bet.body.externalTransactionId,
      }),
    );

    expect(status).toBe(422);
    expect(body).toMatchObject({
      status: "REJECTED",
      failureCode: "REFERENCE_SCOPE_MISMATCH",
      failureDetail: "WALLET",
    });
    expect(await walletState(usdWallet.id)).toEqual({ balance: "100.00", version: 1 });
  });

  it("R-07-07 D14.2 D14.3: referência de outro player → 422 REFERENCE_SCOPE_MISMATCH com failureDetail PLAYER", async () => {
    const owner = await createWallet(api, brl("100.00"));
    const other = await createWallet(api, brl("100.00"));
    const bet = await processed(owner, { money: brl("10.00") });

    const { status, body } = await submit(
      api,
      wagerBody(other, {
        kind: "REFUND",
        money: brl("10.00"),
        referenceExternalTransactionId: bet.body.externalTransactionId,
      }),
    );

    expect(status).toBe(422);
    expect(body).toMatchObject({
      status: "REJECTED",
      failureCode: "REFERENCE_SCOPE_MISMATCH",
      failureDetail: "PLAYER",
    });
    expect(await walletState(other.id)).toEqual({ balance: "100.00", version: 1 });
  });

  describe("D1.4: estado da referência", () => {
    it("D1.4 R-07-07: WIN de uma BET REJECTED → 422 REFERENCE_NOT_PROCESSED, sem crédito", async () => {
      const wallet = await createWallet(api, brl("100.00"));
      const bet = wagerBody(wallet, { money: brl("500.00") });
      const refused = await submit(api, bet);
      expect(refused.body.failureCode).toBe("INSUFFICIENT_FUNDS");

      const { status, body } = await submit(
        api,
        wagerBody(wallet, {
          kind: "WIN",
          money: brl("1000.00"),
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
      );

      expect(status).toBe(422);
      expect(body).toMatchObject({
        status: "REJECTED",
        failureCode: "REFERENCE_NOT_PROCESSED",
        balance: brl("100.00"),
      });
      expect(await entriesOf(body.transactionId)).toEqual([]);
      expect(await walletState(wallet.id)).toEqual({ balance: "100.00", version: 1 });
    });

    it("D1.4 D1.2 R-07-13: ROLLBACK de um REFUND ainda PENDING_REFERENCE → 202 PENDING_REFERENCE, espera", async () => {
      const wallet = await createWallet(api, brl("100.00"));
      const refund = wagerBody(wallet, {
        kind: "REFUND",
        money: brl("10.00"),
        referenceExternalTransactionId: newExternalId("ausente"),
      });
      expect((await submit(api, refund)).status).toBe(202);

      const { status, body } = await submit(
        api,
        wagerBody(wallet, {
          kind: "ROLLBACK",
          money: brl("10.00"),
          referenceExternalTransactionId: refund.externalTransactionId,
        }),
      );

      expect(status).toBe(202);
      expect(body).toEqual({
        transactionId: expect.stringMatching(UUID),
        status: "PENDING_REFERENCE",
        idempotentReplay: false,
      });
      expect(await walletState(wallet.id)).toEqual({ balance: "100.00", version: 1 });
    });
  });

  it("R-07-13 R-11-07 D4.1 D17.4: referência ausente → 202 PENDING_REFERENCE sem balance, já vencida para o worker, evento WagerTransactionPendingReference", async () => {
    const wallet = await createWallet(api);

    const { status, body } = await submit(
      api,
      wagerBody(wallet, {
        kind: "REFUND",
        money: brl("10.00"),
        referenceExternalTransactionId: newExternalId("ausente"),
      }),
    );

    expect(status).toBe(202);
    expect(body).toEqual({
      transactionId: expect.stringMatching(UUID),
      status: "PENDING_REFERENCE",
      idempotentReplay: false,
    });
    expect(await transactionRow(body.transactionId)).toMatchObject({
      status: "PENDING_REFERENCE",
      balance_after: null,
      due_at_creation: true,
    });
    const events = await eventsAfterOpening(wallet.id);
    expect(events.map((event) => event.event_type)).toEqual(["WagerTransactionPendingReference"]);
  });

  describe("D1.1 D1.3: reversão única por referência", () => {
    it("R-07-04 R-07-05 D1.1: REFUND PROCESSED de uma BET, depois ROLLBACK da mesma BET → 422 REFERENCE_ALREADY_REVERSED", async () => {
      const wallet = await createWallet(api, brl("100.00"));
      const bet = await processed(wallet, { money: brl("40.00") });
      await processed(wallet, {
        kind: "REFUND",
        money: brl("40.00"),
        referenceExternalTransactionId: bet.body.externalTransactionId,
      });

      const { status, body } = await submit(
        api,
        wagerBody(wallet, {
          kind: "ROLLBACK",
          money: brl("40.00"),
          referenceExternalTransactionId: bet.body.externalTransactionId,
        }),
      );

      expect(status).toBe(422);
      expect(body).toMatchObject({
        status: "REJECTED",
        failureCode: "REFERENCE_ALREADY_REVERSED",
        balance: brl("100.00"),
      });
      expect(await walletState(wallet.id)).toEqual({ balance: "100.00", version: 3 });
    });

    it("R-07-14 D1.3: ROLLBACK de WIN rejeitado por INSUFFICIENT_FUNDS_FOR_REVERSAL não conta; outro ROLLBACK do mesmo WIN, com saldo, → 200", async () => {
      const wallet = await createWallet(api, brl("10.00"));
      const win = await processed(wallet, { kind: "WIN", money: brl("50.00") });
      await processed(wallet, { kind: "BET", money: brl("55.00") });

      const refused = await submit(
        api,
        wagerBody(wallet, {
          kind: "ROLLBACK",
          money: brl("50.00"),
          referenceExternalTransactionId: win.body.externalTransactionId,
        }),
      );
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({
        failureCode: "INSUFFICIENT_FUNDS_FOR_REVERSAL",
        balance: brl("5.00"),
      });

      await processed(wallet, { kind: "WIN", money: brl("100.00") });
      const retried = await submit(
        api,
        wagerBody(wallet, {
          kind: "ROLLBACK",
          money: brl("50.00"),
          referenceExternalTransactionId: win.body.externalTransactionId,
        }),
      );

      expect(retried.status).toBe(200);
      expect(retried.body).toMatchObject({ status: "PROCESSED", balance: brl("55.00") });
      expect((await transactionRow(retried.body.transactionId)).reference_transaction_id).toBe(
        win.result.body.transactionId,
      );
    });
  });

  describe("R-09-15 D3.4: replay", () => {
    const cases: [string, (wallet: TestWallet) => SubmissionInput, number][] = [
      ["PROCESSED", (wallet) => wagerBody(wallet, { money: brl("10.00") }), 200],
      ["REJECTED", (wallet) => wagerBody(wallet, { money: brl("1000.00") }), 422],
      [
        "PENDING_REFERENCE",
        (wallet) =>
          wagerBody(wallet, {
            kind: "ROLLBACK",
            money: brl("10.00"),
            referenceExternalTransactionId: newExternalId("ausente"),
          }),
        202,
      ],
    ];

    it.each(cases)(
      "R-09-15 R-07-12 D3.4: %s repetido → mesmo status e corpo, idempotentReplay true, nada novo gravado",
      async (_, build, expectedStatus) => {
        const wallet = await createWallet(api, brl("100.00"));
        const body = build(wallet);

        const first = await submit(api, body);
        const eventsBefore = await eventsAfterOpening(wallet.id);
        const replay = await submit(api, body);

        expect(first.status).toBe(expectedStatus);
        expect(replay.status).toBe(expectedStatus);
        expect(first.body.idempotentReplay).toBe(false);
        expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
        expect(await writtenFor(body.providerId, body.externalTransactionId)).toMatchObject({
          transactions: 1,
        });
        expect(await eventsAfterOpening(wallet.id)).toHaveLength(eventsBefore.length);
      },
    );

    it('R-07-12 D3.5: replay devolve o saldo observado na época, não o atual', async () => {
      const wallet = await createWallet(api, brl("100.00"));
      const body = wagerBody(wallet, { money: brl("10.00") });
      await submit(api, body);
      await processed(wallet, { money: brl("20.00") });

      const replay = await submit(api, body);

      expect(replay.body).toMatchObject({ balance: brl("90.00"), idempotentReplay: true });
    });

    it('D2.1 D3.3: "25" e depois "25.00" com a mesma key → replay, não conflito', async () => {
      const wallet = await createWallet(api, brl("100.00"));
      const body = wagerBody(wallet, { money: brl("25") });

      const first = await submit(api, body);
      const replay = await submit(api, { ...body, money: brl("25.00") });

      expect(first.status).toBe(200);
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
      expect(await walletState(wallet.id)).toEqual({ balance: "75.00", version: 2 });
    });

    it("D3.3: mesma key e mesmo conteúdo com as chaves em outra ordem → replay", async () => {
      const wallet = await createWallet(api, brl("100.00"));
      const body = wagerBody(wallet, { money: brl("10.00") });
      const reversed = Object.fromEntries(Object.entries(body).reverse()) as SubmissionInput;

      await submit(api, body);
      const replay = await submit(api, reversed);

      expect(replay.status).toBe(200);
      expect(replay.body.idempotentReplay).toBe(true);
    });
  });

  describe("R-09-16 D3.1 D3.2 D17.2: conflitos", () => {
    it("R-09-16 R-06-39 D17.2: mesma key com payload diferente → 409 IDEMPOTENCY_KEY_CONFLICT com o transactionId, nada gravado", async () => {
      const wallet = await createWallet(api, brl("100.00"));
      const body = wagerBody(wallet, { money: brl("10.00") });
      const original = await submit(api, body);

      const { status, body: error } = (await submit(api, {
        ...body,
        money: brl("11.00"),
      })) as unknown as { status: number; body: ErrorBody };

      expect(status).toBe(409);
      expect(error.error).toMatchObject({
        code: "IDEMPOTENCY_KEY_CONFLICT",
        details: { transactionId: original.body.transactionId },
      });
      expect(await walletState(wallet.id)).toEqual({ balance: "90.00", version: 2 });
      expect(await writtenFor(body.providerId, body.externalTransactionId)).toMatchObject({
        transactions: 1,
      });
    });

    it("D3.2 D17.2: outra key com o mesmo externalTransactionId → 409 EXTERNAL_ID_CONFLICT com o transactionId", async () => {
      const wallet = await createWallet(api, brl("100.00"));
      const body = wagerBody(wallet, { money: brl("10.00") });
      const original = await submit(api, body);

      const { status, body: error } = (await submit(api, body, {
        key: `outra-key:${Bun.randomUUIDv7()}`,
      })) as unknown as { status: number; body: ErrorBody };

      expect(status).toBe(409);
      expect(error.error).toMatchObject({
        code: "EXTERNAL_ID_CONFLICT",
        details: { transactionId: original.body.transactionId },
      });
      expect(await walletState(wallet.id)).toEqual({ balance: "90.00", version: 2 });
    });

    it("D3.1: a mesma key em dois provedores é outra transação, não conflito", async () => {
      const wallet = await createWallet(api, brl("100.00"));
      const externalTransactionId = newExternalId();
      const key = `shared:${externalTransactionId}`;

      const a = await submit(api, wagerBody(wallet, { externalTransactionId, money: brl("10.00") }), {
        key,
      });
      const b = await submit(
        api,
        wagerBody(wallet, { providerId: "provider-b", externalTransactionId, money: brl("10.00") }),
        { key },
      );

      expect([a.status, b.status]).toEqual([200, 200]);
      expect(b.body.idempotentReplay).toBe(false);
      expect(await walletState(wallet.id)).toEqual({ balance: "80.00", version: 3 });
    });
  });

  describe("D5 D17.1: payload inválido → 400, nada gravado", () => {
    const invalid: [string, Record<string, unknown>, { key?: string | null }?][] = [
      ["sem Idempotency-Key", {}, { key: null }],
      ["Idempotency-Key vazia", {}, { key: "" }],
      ["Idempotency-Key com 256 caracteres", {}, { key: "k".repeat(256) }],
      ["kind OPENING", { kind: "OPENING" }],
      ["kind desconhecido", { kind: "JACKPOT" }],
      ["REFUND sem referência", { kind: "REFUND" }],
      ["ROLLBACK sem referência", { kind: "ROLLBACK" }],
      ["BET com referência", { referenceExternalTransactionId: "bet-x" }],
      ["BET com valor 0.00", { money: brl("0.00") }],
      ["3 casas decimais", { money: brl("10.001") }],
      ["valor negativo", { money: brl("-10.00") }],
      ["amount numérico", { money: { amount: 10, currency: "BRL" } }],
      ["moeda fora da lista", { money: { amount: "10.00", currency: "EUR" } }],
      ["walletId não UUID", { walletId: "wallet-1" }],
      ["providerId com espaço", { providerId: "provider a" }],
      ["externalTransactionId com 129 caracteres", { externalTransactionId: "e".repeat(129) }],
      ["roundId ausente", { roundId: undefined }],
      ["gameId vazio", { gameId: "" }],
      ["referência fora do formato", { kind: "WIN", referenceExternalTransactionId: "tem espaço" }],
      ["playerId fora do formato", { playerId: "player 1" }],
    ];

    // `options` com default: o Bun lê um 3º parâmetro obrigatório como `done`.
    it.each(invalid)("D5 D17.1: %s → 400 VALIDATION_ERROR", async (_, override, options = {}) => {
      const wallet = await createWallet(api);
      const body = wagerBody(wallet, override);
      const token = await api.issuer.providerToken("provider-a");

      const { status, body: error } = (await submit(api, body, {
        token,
        ...(options.key !== undefined && { key: options.key }),
      })) as unknown as { status: number; body: ErrorBody };

      expect(status).toBe(400);
      expect(error.error.code).toBe("VALIDATION_ERROR");
      expect(await walletState(wallet.id)).toEqual({ balance: "100.00", version: 1 });
      expect(await eventsAfterOpening(wallet.id)).toEqual([]);
    });

    it("D5: LOSS com valor 0.00 é válido (D2.3)", async () => {
      const wallet = await createWallet(api);

      const { status } = await submit(api, wagerBody(wallet, { kind: "LOSS", money: brl("0.00") }));

      expect(status).toBe(200);
    });
  });

  it("D5: wallet inexistente → 404 NOT_FOUND, nada gravado", async () => {
    const body = wagerBody({ id: Bun.randomUUIDv7(), playerId: "player-x" });

    const { status, body: error } = (await submit(api, body)) as unknown as {
      status: number;
      body: ErrorBody;
    };

    expect(status).toBe(404);
    expect(error.error.code).toBe("NOT_FOUND");
    expect(await writtenFor(body.providerId, body.externalTransactionId)).toEqual({
      transactions: 0,
      events: 0,
    });
  });

  describe("D10.2: identidade do token", () => {
    it.each([
      ["sem token", null, 401, "UNAUTHENTICATED"],
      ["token de operator", "operator", 403, "FORBIDDEN"],
      ["token de outro provedor", "provider-b", 403, "FORBIDDEN"],
    ])("D10.2 D10.1: %s → %d, nada gravado", async (_, who, expectedStatus, code) => {
      const wallet = await createWallet(api);
      const body = wagerBody(wallet);
      const token =
        who === null
          ? null
          : who === "operator"
            ? await api.issuer.operatorToken()
            : await api.issuer.providerToken(who);

      const { status, body: error } = (await submit(api, body, { token })) as unknown as {
        status: number;
        body: ErrorBody;
      };

      expect(status).toBe(expectedStatus);
      expect(error.error.code).toBe(code);
      expect(await writtenFor(body.providerId, body.externalTransactionId)).toEqual({
        transactions: 0,
        events: 0,
      });
    });
  });
});

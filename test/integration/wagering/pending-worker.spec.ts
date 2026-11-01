import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { Client } from "pg";
import { payloadHash } from "../../../src/modules/wagering/application/payload-hash";
import type { UnitOfWork } from "../../../src/modules/wagering/application/ports";
import { Money } from "../../../src/modules/wagering/domain/money";
import type { WagerTransactionKind } from "../../../src/modules/wagering/domain/wager-transaction";
import { startTestApi, type TestApi } from "../../support/api";
import { connect, newId, withClient } from "../../support/db";
import { expectLedgerMatchesBalances } from "../../support/db-ledger-invariant";
import { insertRow, transactionRow } from "../../support/db-seed";
import {
  brl,
  createWallet,
  eventsAfterOpening,
  newExternalId,
  type SubmissionInput,
  submit,
  type TestWallet,
  wagerBody,
} from "../../support/wagering";
import {
  makeDue,
  parkPendings,
  pendingRow,
  runWorkerUntil,
  startTestWorker,
  type TestWorker,
} from "../../support/worker";

const MINUTE = 60 * 1000;

let api: TestApi;
let worker: TestWorker;
let db: Client;

beforeAll(async () => {
  api = await startTestApi();
  worker = await startTestWorker();
  db = await connect("app");
});

/** Pendentes criadas pelo teste atual, estacionadas no fim dele (`parkPendings`). */
const created: string[] = [];

// Todo teste que move dinheiro termina com o invariante (CLAUDE.md, D11.4).
afterEach(async () => {
  await parkPendings(db, created);
  await expectLedgerMatchesBalances();
});

afterAll(async () => {
  await worker.close();
  await api.close();
  await db.end();
});

async function pendingSubmission(wallet: TestWallet, overrides: Record<string, unknown>) {
  const body = wagerBody(wallet, overrides);
  const result = await submit(api, body);
  if (result.status !== 202) throw new Error(`esperava 202, veio ${result.status}`);
  created.push(result.body.transactionId);
  return { body, id: result.body.transactionId };
}

const refundOf = (externalTransactionId: string, overrides: Record<string, unknown> = {}) => ({
  kind: "REFUND",
  money: brl("10.00"),
  referenceExternalTransactionId: externalTransactionId,
  ...overrides,
});

/** "Ainda no backoff": vence só daqui a uma hora (colunas de controle, D4.5). */
async function pushToFuture(...ids: string[]): Promise<void> {
  await db.query(
    "UPDATE wager_transactions SET next_attempt_at = now() + interval '1 hour' WHERE id = ANY($1)",
    [ids],
  );
}

async function isDueNow(id: string): Promise<boolean> {
  const { rows } = await db.query<{ due: boolean }>(
    "SELECT next_attempt_at <= now() AS due FROM wager_transactions WHERE id = $1",
    [id],
  );
  return rows[0]?.due ?? false;
}

const settled = (id: string) => async () => (await pendingRow(id)).status !== "PENDING_REFERENCE";

/**
 * `REFUND` pendente gravado por SQL com `created_at` no passado (o prazo é
 * contado da criação, e `created_at` é imutável). Key e hash são os que a
 * API calcularia, então a resubmissão é replay (D3.3).
 */
async function seedOldPending(
  wallet: TestWallet,
  options: { ageMs: number; reference: string; kind?: "REFUND" | "ROLLBACK" },
): Promise<{ id: string; body: SubmissionInput }> {
  const kind = options.kind ?? "REFUND";
  const body = wagerBody(wallet, refundOf(options.reference, { kind }));
  const hash = payloadHash({
    providerId: body.providerId,
    externalTransactionId: body.externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: String(body.roundId),
    gameId: String(body.gameId),
    kind: kind as WagerTransactionKind,
    money: Money.from({ amount: "10.00", currency: "BRL" }),
    referenceExternalTransactionId: options.reference,
  });
  const createdAt = new Date(Date.now() - options.ageMs);
  const row = transactionRow(
    { id: wallet.id, playerId: wallet.playerId, currency: "BRL" },
    {
      provider_id: body.providerId,
      external_transaction_id: body.externalTransactionId,
      idempotency_key: `${body.providerId}:${body.externalTransactionId}`,
      payload_hash: hash,
      round_id: String(body.roundId),
      game_id: String(body.gameId),
      kind,
      amount: "10.00",
      reference_external_transaction_id: options.reference,
      status: "PENDING_REFERENCE",
      balance_after: null,
      balance_after_currency: null,
      processed_at: null,
      created_at: createdAt,
      updated_at: createdAt,
      next_attempt_at: new Date(),
      correlation_id: `corr-seed-${newId()}`,
    },
  );
  await insertRow(db, "wager_transactions", row);
  created.push(row.id);
  return { id: row.id, body };
}

async function walletBalance(walletId: string): Promise<string> {
  const { rows } = await db.query<{ balance: string }>(
    "SELECT balance::text AS balance FROM wallets WHERE id = $1",
    [walletId],
  );
  return rows[0]?.balance as string;
}

async function eventsOf(transactionId: string) {
  return withClient("app", async (client) => {
    const { rows } = await client.query<{
      event_type: string;
      payload: { correlationId: string; causationId?: string; data: Record<string, unknown> };
    }>(
      "SELECT event_type, payload FROM outbox_messages WHERE aggregate_id = $1 ORDER BY position",
      [transactionId],
    );
    return rows;
  });
}

/** Eventos de uma mesma tentativa do worker (mesma causação, D18.3), em ordem. */
async function eventsCausedBy(causationId: string) {
  return withClient("app", async (client) => {
    const { rows } = await client.query<{
      event_type: string;
      payload: { correlationId: string; causationId?: string };
    }>(
      `SELECT event_type, payload FROM outbox_messages
        WHERE payload->>'causationId' = $1 ORDER BY position`,
      [causationId],
    );
    return rows;
  });
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("S5 R-07-20..22 D4.3: worker de pendentes", () => {
  it("R-07-20 D4.3 D4.6 D18.1: referência ainda ausente → continua PENDING_REFERENCE, attempts 1, backoff de 1 s, lease solto, sem evento novo", async () => {
    const wallet = await createWallet(api, brl("100.00"));
    const { id } = await pendingSubmission(wallet, refundOf(newExternalId("bet")));

    const before = Date.now();
    await runWorkerUntil(worker, async () => (await pendingRow(id)).attempts >= 1);
    const after = Date.now();

    const row = await pendingRow(id);
    expect(row).toMatchObject({
      status: "PENDING_REFERENCE",
      attempts: 1,
      consecutive_errors: 0,
      locked_until: null,
    });
    // Tolerância de 250 ms para a diferença de relógio entre a máquina e o container.
    const next = (row.next_attempt_at as Date).getTime();
    expect(next).toBeGreaterThanOrEqual(before + 1000 - 250);
    expect(next).toBeLessThanOrEqual(after + 1000 + 250);
    expect((await eventsOf(id)).map((event) => event.event_type)).toEqual([
      "WagerTransactionPendingReference",
    ]);
  });

  it("R-07-21 R-07-22 D4.3 D9.5 D18.3: prazo esgotado (criada há 16 min) → REJECTED REFERENCE_NOT_FOUND com o saldo, evento com o correlationId original, replay 422", async () => {
    const wallet = await createWallet(api, brl("100.00"));
    const seeded = await seedOldPending(wallet, { ageMs: 16 * MINUTE, reference: newExternalId("bet") });

    await runWorkerUntil(worker, settled(seeded.id));

    expect(await pendingRow(seeded.id)).toMatchObject({
      status: "REJECTED",
      failure_code: "REFERENCE_NOT_FOUND",
      balance_after: "100.00",
      attempts: 1,
    });
    const events = await eventsOf(seeded.id);
    expect(events.map((event) => event.event_type)).toEqual(["WagerTransactionRejected"]);
    expect(events[0]?.payload.data.failureCode).toBe("REFERENCE_NOT_FOUND");
    expect(events[0]?.payload.correlationId).toStartWith("corr-seed-");
    // Causação = um UUIDv7 por tentativa, não a correlação (D18.3).
    expect(events[0]?.payload.causationId).toMatch(UUID_V7);
    expect(events[0]?.payload.causationId).not.toBe(events[0]?.payload.correlationId as string);
    expect(await walletBalance(wallet.id)).toBe("100.00");

    const replay = await submit(api, seeded.body);
    expect(replay.status).toBe(422);
    expect(replay.body).toMatchObject({
      transactionId: seeded.id,
      status: "REJECTED",
      failureCode: "REFERENCE_NOT_FOUND",
      balance: brl("100.00"),
      idempotentReplay: true,
    });
  });

  it("D18.5: a referência chega depois do prazo, antes da tentativa → aplicada, não expirada", async () => {
    const wallet = await createWallet(api, brl("100.00"));
    const betId = newExternalId("bet");
    const seeded = await seedOldPending(wallet, { ageMs: 20 * MINUTE, reference: betId });
    expect(
      (await submit(api, wagerBody(wallet, { externalTransactionId: betId, money: brl("10.00") }))).status,
    ).toBe(200);

    await runWorkerUntil(worker, settled(seeded.id));

    expect(await pendingRow(seeded.id)).toMatchObject({ status: "PROCESSED", failure_code: null });
    expect(await walletBalance(wallet.id)).toBe("100.00");
  });

  it("D4.3 D1.4: referência ainda PENDING_REFERENCE no fim do prazo → REFERENCE_NOT_FOUND", async () => {
    const wallet = await createWallet(api, brl("100.00"));
    const refund = await pendingSubmission(wallet, refundOf(newExternalId("bet")));
    const rollback = await seedOldPending(wallet, {
      ageMs: 16 * MINUTE,
      reference: refund.body.externalTransactionId,
      kind: "ROLLBACK",
    });

    await runWorkerUntil(worker, settled(rollback.id));

    expect(await pendingRow(rollback.id)).toMatchObject({
      status: "REJECTED",
      failure_code: "REFERENCE_NOT_FOUND",
    });
    expect((await pendingRow(refund.id)).status).toBe("PENDING_REFERENCE");
  });
});

describe("S5 D4.4 D18.6: cutucada", () => {
  it("D4.4: BET submetida → as pendentes da mesma wallet que a referenciam vencem agora; as de outra referência e de outra wallet, não", async () => {
    const wallet = await createWallet(api, brl("100.00"));
    const other = await createWallet(api, brl("100.00"));
    const betId = newExternalId("bet");
    const waiting = await pendingSubmission(wallet, refundOf(betId));
    const unrelated = await pendingSubmission(wallet, refundOf(newExternalId("bet")));
    const otherWallet = await pendingSubmission(other, refundOf(betId));
    await pushToFuture(waiting.id, unrelated.id, otherWallet.id);

    const bet = await submit(api, wagerBody(wallet, { externalTransactionId: betId, money: brl("10.00") }));

    expect(bet.status).toBe(200);
    expect(await isDueNow(waiting.id)).toBe(true);
    expect(await isDueNow(unrelated.id)).toBe(false);
    expect(await isDueNow(otherWallet.id)).toBe(false);
    // Só o vencimento muda: tentativas e status ficam (D18.6).
    expect(await pendingRow(waiting.id)).toMatchObject({ status: "PENDING_REFERENCE", attempts: 0 });
  });

  it("D4.4: uma BET REJECTED também cutuca (estado terminal) → o REFUND vira REFERENCE_NOT_PROCESSED", async () => {
    const wallet = await createWallet(api, brl("10.00"));
    const betId = newExternalId("bet");
    const waiting = await pendingSubmission(wallet, refundOf(betId, { money: brl("50.00") }));
    await pushToFuture(waiting.id);

    const bet = await submit(api, wagerBody(wallet, { externalTransactionId: betId, money: brl("50.00") }));
    expect(bet.status).toBe(422);
    expect(await isDueNow(waiting.id)).toBe(true);

    await runWorkerUntil(worker, settled(waiting.id));
    expect(await pendingRow(waiting.id)).toMatchObject({
      status: "REJECTED",
      failure_code: "REFERENCE_NOT_PROCESSED",
    });
  });

  it("D4.4 D18.6 D1.2 D18.3: o worker resolve o REFUND pendente → o ROLLBACK pendente dele é cutucado e depois aplicado; cada tentativa tem a sua causação", async () => {
    const wallet = await createWallet(api, brl("100.00"));
    const betId = newExternalId("bet");
    const refund = await pendingSubmission(wallet, refundOf(betId));
    const rollback = await pendingSubmission(wallet, {
      kind: "ROLLBACK",
      money: brl("10.00"),
      referenceExternalTransactionId: refund.body.externalTransactionId,
    });
    await pushToFuture(refund.id, rollback.id);

    await submit(api, wagerBody(wallet, { externalTransactionId: betId, money: brl("10.00") }));
    expect(await isDueNow(refund.id)).toBe(true);
    expect(await isDueNow(rollback.id)).toBe(false);

    await runWorkerUntil(worker, settled(refund.id));
    expect((await pendingRow(refund.id)).status).toBe("PROCESSED");
    expect(await isDueNow(rollback.id)).toBe(true);

    await runWorkerUntil(worker, settled(rollback.id));
    expect((await pendingRow(rollback.id)).status).toBe("PROCESSED");
    // BET −10, REFUND +10, ROLLBACK do REFUND −10.
    expect(await walletBalance(wallet.id)).toBe("90.00");

    // D18.3: os eventos do worker têm a causação da tentativa (UUIDv7),
    // diferente da correlação; os da mesma tentativa compartilham a causação,
    // e tentativas diferentes têm causações diferentes.
    const byAttempt = async (id: string) => {
      const processed = (await eventsOf(id)).filter(
        (event) => event.event_type === "WagerTransactionProcessed",
      );
      expect(processed).toHaveLength(1);
      const causation = processed[0]?.payload.causationId as string;
      expect(causation).toMatch(UUID_V7);
      const sameAttempt = await eventsCausedBy(causation);
      expect(sameAttempt.map((event) => event.event_type)).toEqual([
        "WagerTransactionProcessed",
        "WalletBalanceChanged",
      ]);
      for (const event of sameAttempt) expect(event.payload.correlationId).not.toBe(causation);
      return causation;
    };
    expect(await byAttempt(refund.id)).not.toBe((await byAttempt(rollback.id)) as string);
  });
});

describe("S5 D4.2 D18.4: erros do worker", () => {
  /** Falha injetada na busca da referência de `externalId`, enquanto `active()`. */
  function failingLookup(
    externalId: string,
    error: () => Error,
    active: () => boolean,
  ): (uow: UnitOfWork) => UnitOfWork {
    return (uow) => ({
      run: (work, options) =>
        uow.run(
          (scope) =>
            work({
              ...scope,
              transactions: {
                ...scope.transactions,
                findReference: async (providerId, reference) => {
                  if (reference === externalId && active()) throw error();
                  return scope.transactions.findReference(providerId, reference);
                },
              },
            }),
          options,
        ),
    });
  }

  async function attemptsUntil(failing: TestWorker, id: string, attempts: number): Promise<void> {
    await makeDue(db, id);
    await runWorkerUntil(failing, async () => (await pendingRow(id)).attempts >= attempts);
  }

  it("D4.2 D14.1 D16.4 D18.4: 5 erros seguidos → FAILED PROCESSING_FAILED, evento WagerTransactionFailed com o correlationId original, replay 500", async () => {
    const wallet = await createWallet(api, brl("100.00"));
    const betId = newExternalId("bet");
    const pending = await pendingSubmission(wallet, refundOf(betId));
    const failing = await startTestWorker({
      wrapUow: failingLookup(betId, () => new Error("falha injetada"), () => true),
    });
    try {
      for (let attempt = 1; attempt <= 4; attempt++) {
        await attemptsUntil(failing, pending.id, attempt);
        expect(await pendingRow(pending.id)).toMatchObject({
          status: "PENDING_REFERENCE",
          consecutive_errors: attempt,
        });
      }
      await attemptsUntil(failing, pending.id, 5);
    } finally {
      await failing.close();
    }

    expect(await pendingRow(pending.id)).toMatchObject({
      status: "FAILED",
      failure_code: "PROCESSING_FAILED",
      attempts: 5,
      consecutive_errors: 5,
      balance_after: null,
    });
    const events = await eventsOf(pending.id);
    expect(events.map((event) => event.event_type)).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionFailed",
    ]);
    expect(events[1]?.payload.correlationId).toBe(events[0]?.payload.correlationId as string);

    const replay = await submit(api, pending.body);
    expect(replay.status).toBe(500);
    expect(replay.body).toMatchObject({ status: "FAILED", failureCode: "PROCESSING_FAILED" });
  });

  it("D18.1 D18.4: 4 erros e depois uma tentativa sem erro → consecutive_errors volta a 0, continua pendente", async () => {
    const wallet = await createWallet(api, brl("100.00"));
    const betId = newExternalId("bet");
    const pending = await pendingSubmission(wallet, refundOf(betId));
    let failing = true;
    const flaky = await startTestWorker({
      wrapUow: failingLookup(betId, () => new Error("falha injetada"), () => failing),
    });
    try {
      for (let attempt = 1; attempt <= 4; attempt++) await attemptsUntil(flaky, pending.id, attempt);
      failing = false;
      await attemptsUntil(flaky, pending.id, 5);
    } finally {
      await flaky.close();
    }

    expect(await pendingRow(pending.id)).toMatchObject({
      status: "PENDING_REFERENCE",
      attempts: 5,
      consecutive_errors: 0,
    });
  });

  it("D18.4: erro transitório (SQLSTATE 55P03, lock_timeout) → attempts sobe, consecutive_errors não", async () => {
    const wallet = await createWallet(api, brl("100.00"));
    const betId = newExternalId("bet");
    const pending = await pendingSubmission(wallet, refundOf(betId));
    const transient = await startTestWorker({
      wrapUow: failingLookup(
        betId,
        () => Object.assign(new Error("lock timeout injetado"), { code: "55P03" }),
        () => true,
      ),
    });
    try {
      for (let attempt = 1; attempt <= 6; attempt++) await attemptsUntil(transient, pending.id, attempt);
    } finally {
      await transient.close();
    }

    expect(await pendingRow(pending.id)).toMatchObject({
      status: "PENDING_REFERENCE",
      attempts: 6,
      consecutive_errors: 0,
    });
  });
});

describe("S5 D3.4: replay depois da resolução", () => {
  it("R-13-C7 D3.4 D9.5: REFUND antes da BET → 202; resolvido pelo worker → o replay devolve 200 PROCESSED com balance e idempotentReplay true; eventos com o correlationId da submissão", async () => {
    const wallet = await createWallet(api, brl("100.00"));
    const betId = newExternalId("bet");
    const refundBody = wagerBody(wallet, refundOf(betId));
    const correlationId = `corr-s5-${newId()}`;
    const first = await submit(api, refundBody, { headers: { "x-correlation-id": correlationId } });
    expect(first.status).toBe(202);
    expect(first.body.balance).toBeUndefined();

    await submit(api, wagerBody(wallet, { externalTransactionId: betId, money: brl("10.00") }));
    await runWorkerUntil(worker, settled(first.body.transactionId));

    const replay = await submit(api, refundBody);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({
      transactionId: first.body.transactionId,
      status: "PROCESSED",
      balance: brl("100.00"),
      idempotentReplay: true,
    });
    const events = await eventsOf(first.body.transactionId);
    expect(events.map((event) => event.event_type)).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionProcessed",
    ]);
    for (const event of events) expect(event.payload.correlationId).toBe(correlationId);
    // O WalletBalanceChanged do REFUND é da wallet (aggregateId), com a mesma correlação.
    const balanceEvents = (await eventsAfterOpening(wallet.id)).filter(
      (event) => event.event_type === "WalletBalanceChanged",
    );
    expect(balanceEvents.at(-1)?.payload.correlationId).toBe(correlationId);
  });
});

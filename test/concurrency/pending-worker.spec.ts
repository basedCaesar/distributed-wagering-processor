import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { Client } from "pg";
import { startTestApi, type TestApi } from "../support/api";
import { connect } from "../support/db";
import { expectLedgerMatchesBalances } from "../support/db-ledger-invariant";
import { transactionRow, writeMovement } from "../support/db-seed";
import type { ClaimedPending } from "../../src/modules/wagering/application/ports";
import {
  brl,
  createWallet,
  holdWalletLock,
  newExternalId,
  submit,
  type TestWallet,
  transactionStartsBlockedBy,
  waitForWalletLockWaiters,
  wagerBody,
} from "../support/wagering";
import {
  parkAllPendings,
  parkPendings,
  pendingRow,
  runWorkerUntil,
  startNestWorker,
  startTestWorker,
} from "../support/worker";

let api: TestApi;
let db: Client;
let observer: Client;

beforeAll(async () => {
  api = await startTestApi();
  db = await connect("app");
  observer = await connect("app");
});

/** Pendentes criadas pelo teste atual, estacionadas no fim dele (`parkPendings`). */
const created: string[] = [];

// Todo teste que move dinheiro termina com o invariante (CLAUDE.md, D11.4).
afterEach(async () => {
  await parkPendings(db, created);
  await expectLedgerMatchesBalances();
});

afterAll(async () => {
  await api.close();
  await db.end();
  await observer.end();
});

async function pendingSubmission(wallet: TestWallet, overrides: Record<string, unknown>) {
  const body = wagerBody(wallet, overrides);
  const result = await submit(api, body);
  if (result.status !== 202) throw new Error(`esperava 202, veio ${result.status}`);
  created.push(result.body.transactionId);
  return { body, id: result.body.transactionId };
}

const reversalOf = (kind: "REFUND" | "ROLLBACK", externalTransactionId: string) => ({
  kind,
  money: brl("10.00"),
  referenceExternalTransactionId: externalTransactionId,
});

/**
 * As linhas passam na frente de qualquer outra pendente do banco no claim
 * (D18.9), para o teste saber o que o claim vai tocar primeiro.
 */
async function moveToFront(ids: string[]): Promise<void> {
  await db.query(
    `UPDATE wager_transactions
        SET next_attempt_at = timestamptz '2000-01-01', locked_until = NULL, locked_by = NULL
      WHERE id = ANY($1)`,
    [ids],
  );
}

async function statusOf(transactionId: string, providerId = "provider-a"): Promise<string> {
  const response = await api.request("GET", `/wagering/transactions/${transactionId}`, {
    token: await api.issuer.providerToken(providerId),
  });
  return ((await response.json()) as { status: string }).status;
}

/** Espera o estado pela API (estado observável, sem `sleep`); devolve quanto levou. */
async function msUntilStatus(transactionId: string, status: string, deadlineMs: number): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    if ((await statusOf(transactionId)) === status) return Date.now() - started;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`${transactionId} não chegou a ${status} em ${deadlineMs} ms`);
}

describe("S5 R-13-C7 D4.4: reversão antes da referência, com o processo pending-worker rodando", () => {
  for (const kind of ["REFUND", "ROLLBACK"] as const) {
    it(`R-13-C7 D4.3 D4.4: ${kind} antes da BET → 202, já com 3 tentativas (backoff de 4 s); depois a BET → o ${kind} é aplicado em cerca de 1 s`, async () => {
      // O worker em laço pega qualquer pendente vencida do banco: as de
      // outros arquivos e rodadas não podem ficar na frente do que se mede.
      await parkAllPendings(db);
      const wallet = await createWallet(api, brl("100.00"));
      const betId = newExternalId("bet");
      const reversal = await pendingSubmission(wallet, reversalOf(kind, betId));
      // Estado depois de 3 tentativas: a próxima, pelo backoff, só em 4 s (D4.3).
      // Sem a cutucada, a reversão esperaria esses 4 s.
      await db.query(
        `UPDATE wager_transactions SET attempts = 3, next_attempt_at = now() + interval '4 seconds'
          WHERE id = $1`,
        [reversal.id],
      );
      const worker = await startNestWorker();
      try {
        const bet = await submit(api, wagerBody(wallet, { externalTransactionId: betId, money: brl("10.00") }));
        expect(bet.status).toBe(200);

        const elapsed = await msUntilStatus(reversal.id, "PROCESSED", 5000);

        // Tick de 1 s (D4.3) mais o processamento; a cutucada evita o backoff.
        expect(elapsed).toBeLessThan(2000);
      } finally {
        await worker.close();
      }
      const replay = await submit(api, reversal.body);
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({ status: "PROCESSED", balance: brl("100.00"), idempotentReplay: true });
    });
  }
});

describe("S5 D1.1 D1.3 D18.9: duas reversões pendentes da mesma BET", () => {
  it("D1.1 D1.3 D18.9: REFUND e ROLLBACK pendentes da mesma BET → a criada primeiro é PROCESSED, a outra REFERENCE_ALREADY_REVERSED, um crédito só", async () => {
    const wallet = await createWallet(api, brl("100.00"));
    const betId = newExternalId("bet");
    const first = await pendingSubmission(wallet, reversalOf("ROLLBACK", betId));
    const second = await pendingSubmission(wallet, reversalOf("REFUND", betId));
    expect((await pendingRow(first.id)).created_at.getTime()).toBeLessThanOrEqual(
      (await pendingRow(second.id)).created_at.getTime(),
    );
    const worker = await startTestWorker();
    try {
      // A BET cutuca as duas com o mesmo now(); o claim desempata por created_at.
      await submit(api, wagerBody(wallet, { externalTransactionId: betId, money: brl("10.00") }));
      await runWorkerUntil(worker, async () => {
        const [a, b] = await Promise.all([pendingRow(first.id), pendingRow(second.id)]);
        return a.status !== "PENDING_REFERENCE" && b.status !== "PENDING_REFERENCE";
      });
    } finally {
      await worker.close();
    }

    expect(await pendingRow(first.id)).toMatchObject({ status: "PROCESSED", failure_code: null });
    expect(await pendingRow(second.id)).toMatchObject({
      status: "REJECTED",
      failure_code: "REFERENCE_ALREADY_REVERSED",
      balance_after: "100.00",
    });
    const { rows } = await db.query<{ credits: number }>(
      `SELECT count(*)::int AS credits FROM wallet_ledger_entries
        WHERE wallet_id = $1 AND direction = 'CREDIT' AND wallet_version > 1`,
      [wallet.id],
    );
    expect(rows[0]?.credits).toBe(1);
  });

  it("D1.1 D7.2 D18.7: as duas reversões pegas por dois workers, os dois esperando o lock da wallet (pg_locks) → só uma aplicada, uma tentativa cada, um crédito", async () => {
    const wallet = await createWallet(api, brl("100.00"));
    const betId = newExternalId("bet");
    const reversals = await Promise.all([
      pendingSubmission(wallet, reversalOf("REFUND", betId)),
      pendingSubmission(wallet, reversalOf("ROLLBACK", betId)),
    ]);
    const bet = await submit(api, wagerBody(wallet, { externalTransactionId: betId, money: brl("10.00") }));
    expect(bet.status).toBe(200);
    const ids = reversals.map((reversal) => reversal.id);
    await moveToFront(ids);
    // Lote de 1: cada worker pega uma reversão. A wallet fica travada até
    // os dois estarem na fila do lock, e só então a corrida começa.
    const workers = await Promise.all([startTestWorker({ batchSize: 1 }), startTestWorker({ batchSize: 1 })]);
    const lock = await holdWalletLock(wallet.id);
    let claimed: string[];
    try {
      const rounds = workers.map((worker) => worker.runOnce());
      try {
        await waitForWalletLockWaiters(observer, lock, 2);
      } finally {
        await lock.release();
      }
      claimed = (await Promise.all(rounds)).flat().map((item) => item.id);
    } finally {
      await lock.release();
      await Promise.all(workers.map((worker) => worker.close()));
    }

    expect([...claimed].sort()).toEqual([...ids].sort());
    const rows = await Promise.all(ids.map((id) => pendingRow(id)));
    expect(rows.map((row) => row.status).sort()).toEqual(["PROCESSED", "REJECTED"]);
    expect(rows.find((row) => row.status === "REJECTED")?.failure_code).toBe("REFERENCE_ALREADY_REVERSED");
    expect(rows.map((row) => row.attempts)).toEqual([1, 1]);
    const { rows: credits } = await db.query<{ credits: number }>(
      `SELECT count(*)::int AS credits FROM wallet_ledger_entries
        WHERE wallet_id = $1 AND direction = 'CREDIT' AND wallet_version > 1`,
      [wallet.id],
    );
    expect(credits[0]?.credits).toBe(1);
  });
});

describe("S5 D4.3 D18.2 D18.7: claim com SKIP LOCKED e lease", () => {
  it("D4.3 D18.2: com um claim em andamento segurando as linhas (FOR UPDATE numa transação aberta), o segundo claim pula essas linhas sem esperar; depois o lease as protege", async () => {
    const wallet = await createWallet(api, brl("100.00"));
    const pendings = await Promise.all(
      [1, 2, 3].map(() => pendingSubmission(wallet, reversalOf("REFUND", newExternalId("bet")))),
    );
    const mine = pendings.map((pending) => pending.id);
    await moveToFront(mine);
    const [workerB, workerC] = await Promise.all([startTestWorker(), startTestWorker()]);

    // "Worker A" no meio do claim: as linhas travadas, transação aberta.
    const holder = await connect("app");
    try {
      await holder.query("BEGIN");
      const locked = await holder.query(
        "SELECT id FROM wager_transactions WHERE id = ANY($1) FOR UPDATE",
        [mine],
      );
      expect(locked.rowCount).toBe(mine.length);

      // Sem SKIP LOCKED, este claim esperaria o holder até o lock_timeout (2 s) e falharia com 55P03.
      const claimedByB = await workerB.queue.claimDue(10, 30_000, workerB.worker.leaseToken);
      expect(claimedByB.filter((item) => mine.includes(item.id))).toEqual([]);
    } finally {
      await holder.query("ROLLBACK");
      await holder.end();
    }

    try {
      await moveToFront(mine);
      const claimedByB = (await workerB.queue.claimDue(10, 30_000, workerB.worker.leaseToken)).filter(
        (item) => mine.includes(item.id),
      );
      expect(claimedByB.map((item) => item.id).sort()).toEqual([...mine].sort());
      // Lease vigente: mesmo vencidas, ninguém mais as pega (D18.2).
      await db.query("UPDATE wager_transactions SET next_attempt_at = now() WHERE id = ANY($1)", [mine]);
      const claimedByC = await workerC.queue.claimDue(10, 30_000, workerC.worker.leaseToken);
      expect(claimedByC.filter((item) => mine.includes(item.id))).toEqual([]);
      for (const id of mine) {
        const row = await pendingRow(id);
        expect(row.locked_until?.getTime()).toBeGreaterThan(Date.now());
        expect(row.locked_by).toBe(workerB.worker.leaseToken);
      }
    } finally {
      // As linhas ficam com o lease de B: não sobram na frente para o próximo teste.
      await Promise.all([workerB.close(), workerC.close()]);
    }
  });

  it("D4.3 D18.7: dois workers (ORMs separados) sobre 20 pendentes de 4 wallets → os conjuntos pegos são disjuntos e cada pendente tem uma tentativa", async () => {
    const wallets = await Promise.all([1, 2, 3, 4].map(() => createWallet(api, brl("100.00"))));
    const pendings = await Promise.all(
      wallets.flatMap((wallet) =>
        [1, 2, 3, 4, 5].map(() => pendingSubmission(wallet, reversalOf("REFUND", newExternalId("bet")))),
      ),
    );
    const mine = new Set(pendings.map((pending) => pending.id));
    await moveToFront([...mine]);
    const workers = await Promise.all([startTestWorker(), startTestWorker()]);
    let claimed: string[][];
    try {
      const rounds = await Promise.all(workers.map((worker) => worker.runOnce()));
      claimed = rounds.map((round) => round.map((item) => item.id).filter((id) => mine.has(id)));
    } finally {
      await Promise.all(workers.map((worker) => worker.close()));
    }

    const [a, b] = claimed as [string[], string[]];
    expect(a.filter((id) => b.includes(id))).toEqual([]);
    expect(new Set([...a, ...b])).toEqual(mine);
    for (const id of mine) {
      expect(await pendingRow(id)).toMatchObject({ status: "PENDING_REFERENCE", attempts: 1 });
    }
  });
});

describe("S5 D4.4 D7.2: cutucada e locks", () => {
  it("D4.4: a cutucada não espera uma pendente travada (SKIP LOCKED): a BET responde 200 e a pendente travada fica como estava", async () => {
    const wallet = await createWallet(api, brl("100.00"));
    const betId = newExternalId("bet");
    const pending = await pendingSubmission(wallet, reversalOf("REFUND", betId));
    await db.query(
      "UPDATE wager_transactions SET next_attempt_at = now() + interval '1 hour' WHERE id = $1",
      [pending.id],
    );

    const holder = await connect("app");
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM wager_transactions WHERE id = $1 FOR UPDATE", [pending.id]);

      // Sem SKIP LOCKED, a BET esperaria o holder até o lock_timeout e daria 503.
      const bet = await submit(api, wagerBody(wallet, { externalTransactionId: betId, money: brl("10.00") }));
      expect(bet.status).toBe(200);
    } finally {
      await holder.query("ROLLBACK");
      await holder.end();
    }
    const { rows } = await db.query<{ due: boolean }>(
      "SELECT next_attempt_at <= now() AS due FROM wager_transactions WHERE id = $1",
      [pending.id],
    );
    expect(rows[0]?.due).toBe(false);
  });

  it("D4.3 D7.2 D18.12: com a wallet travada por uma submissão em andamento, o worker espera o lock (pg_locks), relê e aplica a BET que ela gravou; o processed_at é o now() da transação do worker", async () => {
    const wallet = await createWallet(api, brl("100.00"));
    const betId = newExternalId("bet");
    const pending = await pendingSubmission(wallet, reversalOf("REFUND", betId));
    await moveToFront([pending.id]);
    const worker = await startTestWorker();

    // A "submissão" da BET: trava a wallet e grava, sem commitar ainda.
    const holder = await connect("app");
    let round: Promise<unknown> | undefined;
    let workerTransactionStart: Date | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM wallets WHERE id = $1 FOR UPDATE", [wallet.id]);
      const { rows } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const holderPid = rows[0]?.pid as number;

      round = worker.runOnce();
      await waitForWalletLockWaiters(observer, { pid: holderPid, walletId: wallet.id }, 1);
      [workerTransactionStart] = await transactionStartsBlockedBy(observer, holderPid);

      const bet = transactionRow(
        { id: wallet.id, playerId: wallet.playerId, currency: "BRL" },
        {
          provider_id: "provider-a",
          external_transaction_id: betId,
          round_id: "round-987",
          game_id: "fortune-chimp",
          amount: "10.00",
          balance_after: "90.00",
        },
      );
      await writeMovement(holder, wallet.id, {
        transaction: bet,
        direction: "DEBIT",
        amount: "10.00",
        balanceBefore: "100.00",
        balanceAfter: "90.00",
        walletVersion: 2,
      });
      await holder.query("COMMIT");
      await round;
    } finally {
      await holder.query("ROLLBACK");
      await holder.end();
      await worker.close();
    }

    const row = await pendingRow(pending.id);
    expect(row).toMatchObject({ status: "PROCESSED", attempts: 1 });
    // A transação do worker começou antes de esperar o lock; um relógio da
    // aplicação, lido depois do lock, daria um horário posterior (D18.12).
    expect(workerTransactionStart).toBeDefined();
    expect(row.processed_at?.getTime()).toBe(workerTransactionStart?.getTime() as number);
  });
});

describe("S5 D18.10: dono do lease", () => {
  it("D18.10 D4.3: o lease vence com o item em processamento (worker A esperando a wallet), o worker B reclama; A pula sem contar tentativa nem erro, B tenta uma vez", async () => {
    const wallet = await createWallet(api, brl("100.00"));
    // Sem BET: quem chegar à linha só pode reagendar (attempts + 1).
    const pending = await pendingSubmission(wallet, reversalOf("REFUND", newExternalId("bet")));
    await moveToFront([pending.id]);
    const [workerA, workerB] = await Promise.all([
      startTestWorker({ batchSize: 1 }),
      startTestWorker({ batchSize: 1 }),
    ]);
    const lock = await holdWalletLock(wallet.id);
    let roundA: Promise<ClaimedPending[]> | undefined;
    let roundB: Promise<ClaimedPending[]> | undefined;
    try {
      try {
        roundA = workerA.runOnce();
        await waitForWalletLockWaiters(observer, lock, 1);
        expect((await pendingRow(pending.id)).locked_by).toBe(workerA.worker.leaseToken);

        // O lease de A vence com A ainda esperando a wallet (só colunas de controle).
        await db.query(
          "UPDATE wager_transactions SET locked_until = now() - interval '1 second' WHERE id = $1",
          [pending.id],
        );
        roundB = workerB.runOnce();
        await waitForWalletLockWaiters(observer, lock, 2);
        expect((await pendingRow(pending.id)).locked_by).toBe(workerB.worker.leaseToken);
      } finally {
        await lock.release();
      }
      const [claimedA, claimedB] = await Promise.all([roundA, roundB]);
      expect(claimedA?.map((item) => item.id)).toEqual([pending.id]);
      expect(claimedB?.map((item) => item.id)).toEqual([pending.id]);
    } finally {
      await Promise.all([workerA.close(), workerB.close()]);
    }

    // Sem a checagem do dono, A também reagendaria: attempts = 2.
    expect(await pendingRow(pending.id)).toMatchObject({
      status: "PENDING_REFERENCE",
      attempts: 1,
      consecutive_errors: 0,
      locked_until: null,
      locked_by: null,
    });
  });
});

describe("S5 D18.12: relógio do banco na submissão", () => {
  it("D18.12: created_at e processed_at de uma BET são o now() da transação da submissão, que começou antes de esperar o lock", async () => {
    const wallet = await createWallet(api, brl("100.00"));
    const lock = await holdWalletLock(wallet.id);
    let response: ReturnType<typeof submit> | undefined;
    let submissionStart: Date | undefined;
    try {
      response = submit(api, wagerBody(wallet, { money: brl("10.00") }));
      await waitForWalletLockWaiters(observer, lock, 1);
      [submissionStart] = await transactionStartsBlockedBy(observer, lock.pid);
    } finally {
      await lock.release();
    }
    const result = await response;
    expect(result?.status).toBe(200);

    const { rows } = await db.query<{ created_at: Date; processed_at: Date }>(
      "SELECT created_at, processed_at FROM wager_transactions WHERE id = $1",
      [result?.body.transactionId],
    );
    expect(submissionStart).toBeDefined();
    expect(rows[0]?.created_at.getTime()).toBe(submissionStart?.getTime() as number);
    expect(rows[0]?.processed_at.getTime()).toBe(submissionStart?.getTime() as number);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Client } from "pg";
import {
  balanceChanged,
  journalOf,
  pair,
  playerAccountBalance,
  receivedHalves,
  reconcileWallets,
  startTestAccountingConsumer,
  type TestAccountingConsumer,
} from "../support/accounting";
import { accountingProcessEnv } from "../support/accounting-process";
import { startTestApi } from "../support/api";
import { pollUntil } from "../support/consumer";
import { connect, newId, withClient } from "../support/db";
import { expectLedgerMatchesBalances } from "../support/db-ledger-invariant";
import { createTestTopic, parkAllOutbox, subscribeQueue, type TestTopic, unpublishedCount } from "../support/outbox";
import { ProcessGroup, type TestProcess, waitFor } from "../support/processes";
import { createTestQueues, queueCounts, receiveMessages, sendMessage, type TestQueues } from "../support/sqs";
import { brl, createWallet, submit, type TestWallet, wagerBody } from "../support/wagering";
import type { ApiClient } from "../support/wagering";

/** Dois consumidores e as idas ao LocalStack; a carga sobe 4 processos Bun. */
const SLOW_TEST_MS = 30_000;
const LOAD_TEST_MS = 180_000;

const consumers: TestAccountingConsumer[] = [];
const queuePairs: TestQueues[] = [];

afterEach(async () => {
  for (const consumer of consumers.splice(0)) await consumer.close();
  for (const queues of queuePairs.splice(0)) await queues.destroy();
});

async function queuesForTest(): Promise<TestQueues> {
  const queues = await createTestQueues();
  queuePairs.push(queues);
  return queues;
}

async function consumerOn(
  queues: TestQueues,
  options: { consumerName: string; applicationName: string },
): Promise<TestAccountingConsumer> {
  const consumer = await startTestAccountingConsumer(queues, options);
  consumers.push(consumer);
  return consumer;
}

/** A conta `PLAYER_WALLET` da wallet, criada e commitada antes do teste (ninguém espera um INSERT dela). */
async function createPlayerAccount(walletId: string): Promise<void> {
  await withClient("accounting", (client) =>
    client.query(
      `INSERT INTO accounting.accounts (id, code, nature, currency, wallet_id)
       VALUES ($1, 'PLAYER_WALLET', 'LIABILITY', 'BRL', $2) ON CONFLICT (wallet_id) DO NOTHING`,
      [newId(), walletId],
    ),
  );
}

/**
 * Conta da wallet criada e commitada, depois travada (`FOR UPDATE`) numa
 * transação aberta: os consumidores esperam na linha da conta (D27.4).
 */
async function holdExistingPlayerAccount(walletId: string): Promise<{ release(): Promise<void> }> {
  await createPlayerAccount(walletId);
  const holder = await connect("accounting");
  await holder.query("BEGIN");
  await holder.query("SELECT id FROM accounting.accounts WHERE wallet_id = $1 FOR UPDATE", [walletId]);
  return {
    async release() {
      await holder.query("COMMIT");
      await holder.end();
    },
  };
}

/**
 * Prende o `insertHalf` das metades dadas (D27.4, prova 17): uma transação
 * aberta grava em `received_events` linhas com os mesmos `event_id` (PK),
 * numa transação qualquer. Quem chega no `INSERT` da metade espera nela,
 * **depois** do lock da conta e das leituras das metades. O `ROLLBACK`
 * solta todos sem deixar nada.
 */
async function holdHalfInserts(walletId: string, eventIds: string[]): Promise<{ release(): Promise<void> }> {
  const holder = await connect("accounting");
  await holder.query("BEGIN");
  for (const eventId of eventIds) {
    await holder.query(
      `INSERT INTO accounting.received_events
         (event_id, event_type, transaction_id, wallet_id, wallet_version, currency, amount,
          kind, direction, balance_before, balance_after, occurred_at, received_at)
       VALUES ($1, 'WagerTransactionProcessed', $2, $3, 99, 'BRL', 1.00, 'BET', NULL, NULL, 1.00, now(), now())`,
      [eventId, newId(), walletId],
    );
  }
  return {
    async release() {
      await holder.query("ROLLBACK");
      await holder.end();
    },
  };
}

interface SessionLocks {
  /** Algum lock pedido e ainda não concedido: a sessão está esperando. */
  waiting: boolean;
  /**
   * Tem (concedido ou na fila) o tuple lock de uma linha de
   * `accounting.accounts`: a espera é na conta da wallet. O 1º da fila
   * segura o tuple lock e espera a transação dona da linha; os seguintes
   * esperam o próprio tuple lock.
   */
  onPlayerAccount: boolean;
}

async function sessionLocks(observer: Client, applicationNames: string[]): Promise<Record<string, SessionLocks>> {
  const { rows } = await observer.query<{ app: string; waiting: boolean; on_account: boolean }>(
    `SELECT a.application_name AS app,
            bool_or(NOT l.granted) AS waiting,
            bool_or(l.locktype = 'tuple' AND l.relation = 'accounting.accounts'::regclass) AS on_account
       FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE a.application_name = ANY($1)
      GROUP BY a.application_name`,
    [applicationNames],
  );
  return Object.fromEntries(rows.map((row) => [row.app, { waiting: row.waiting, onPlayerAccount: row.on_account }]));
}

/** Espera, por `pg_locks`, as sessões dadas esperando um lock qualquer (estado observável, sem `sleep`). */
async function waitForWaitingApps(observer: Client, applicationNames: string[]): Promise<void> {
  await waitFor(
    async () => {
      const locks = await sessionLocks(observer, applicationNames);
      return applicationNames.every((app) => locks[app]?.waiting === true);
    },
    `${applicationNames.join(" e ")} esperando lock`,
    10_000,
  );
}

/** Espera, por `pg_locks`, as sessões dadas esperando **na conta da wallet** (`accounting.accounts`). */
async function waitForPlayerAccountWaiters(observer: Client, applicationNames: string[]): Promise<void> {
  await waitFor(
    async () => {
      const locks = await sessionLocks(observer, applicationNames);
      return applicationNames.every((app) => locks[app]?.waiting === true && locks[app]?.onPlayerAccount === true);
    },
    `${applicationNames.join(" e ")} esperando a conta da wallet`,
    10_000,
  );
}

const appsFor = (walletId: string) => [`acc-a-${walletId.slice(-8)}`, `acc-b-${walletId.slice(-8)}`] as const;

describe("D27.4: duas instâncias do accounting ao mesmo tempo", () => {
  it("D27.4 R-11-03: a mesma metade em duas instâncias → uma espera na conta da wallet, a outra na inbox (índice único da primeira); um lançamento, a outra é duplicata", async () => {
    const walletId = newId();
    const bet = pair({ walletId, kind: "BET", direction: "DEBIT", amount: "25.00", before: "100.00", after: "75.00", walletVersion: 2 });
    const [queuesA, queuesB] = [await queuesForTest(), await queuesForTest()];
    const consumerName = `accounting-c-${newId()}`;
    const [appA, appB] = appsFor(walletId);
    const a = await consumerOn(queuesA, { consumerName, applicationName: appA });
    const b = await consumerOn(queuesB, { consumerName, applicationName: appB });
    await sendMessage(queuesA.queueUrl, bet.processed.body, { groupId: walletId });
    expect(await pollUntil(a, 1)).toEqual(["processed"]);

    await sendMessage(queuesA.queueUrl, bet.balance.body, { groupId: walletId });
    await sendMessage(queuesB.queueUrl, bet.balance.body, { groupId: walletId });
    const lock = await holdExistingPlayerAccount(walletId);
    const observer = await connect("owner");
    let outcomes: string[];
    let locks: Record<string, SessionLocks>;
    try {
      const polls = Promise.all([pollUntil(a, 1), pollUntil(b, 1)]);
      await waitForWaitingApps(observer, [appA, appB]);
      locks = await sessionLocks(observer, [appA, appB]);
      await lock.release();
      outcomes = (await polls).flat().sort();
    } finally {
      await observer.end();
    }

    // Quem pegou a inbox primeiro espera a conta; a outra espera a inbox, sem tocar a conta.
    expect([locks[appA]?.onPlayerAccount, locks[appB]?.onPlayerAccount].sort()).toEqual([false, true]);
    expect(outcomes).toEqual(["duplicate", "processed"]);
    expect(await journalOf(walletId)).toHaveLength(1);
    expect(await playerAccountBalance(walletId)).toBe("-25.00");
  }, SLOW_TEST_MS);

  it("D27.4: as duas metades do mesmo par em duas instâncias, as duas esperando a conta da wallet (pg_locks em accounting.accounts) → exatamente um lançamento", async () => {
    const walletId = newId();
    const bet = pair({ walletId, kind: "BET", direction: "DEBIT", amount: "25.00", before: "100.00", after: "75.00", walletVersion: 2 });
    const [queuesA, queuesB] = [await queuesForTest(), await queuesForTest()];
    const consumerName = `accounting-c-${newId()}`;
    const [appA, appB] = appsFor(walletId);
    const a = await consumerOn(queuesA, { consumerName, applicationName: appA });
    const b = await consumerOn(queuesB, { consumerName, applicationName: appB });
    await sendMessage(queuesA.queueUrl, bet.processed.body, { groupId: walletId });
    await sendMessage(queuesB.queueUrl, bet.balance.body, { groupId: walletId });
    const lock = await holdExistingPlayerAccount(walletId);
    const observer = await connect("owner");
    let outcomes: string[];
    try {
      const polls = Promise.all([pollUntil(a, 1), pollUntil(b, 1)]);
      await waitForPlayerAccountWaiters(observer, [appA, appB]);
      await lock.release();
      outcomes = (await polls).flat();
    } finally {
      await observer.end();
    }

    expect(outcomes).toEqual(["processed", "processed"]);
    const entries = await journalOf(walletId);
    expect(entries.map((entry) => [entry.balance_event_id, entry.processed_event_id])).toEqual([
      [bet.balance.eventId, bet.processed.eventId],
    ]);
  }, SLOW_TEST_MS);

  it("D27.4: as duas metades do mesmo par processadas ao mesmo tempo em duas instâncias, as duas presas ao gravar a metade (pg_locks) → exatamente um lançamento", async () => {
    const walletId = newId();
    const bet = pair({ walletId, kind: "BET", direction: "DEBIT", amount: "25.00", before: "100.00", after: "75.00", walletVersion: 2 });
    const [queuesA, queuesB] = [await queuesForTest(), await queuesForTest()];
    const consumerName = `accounting-c-${newId()}`;
    const [appA, appB] = appsFor(walletId);
    const a = await consumerOn(queuesA, { consumerName, applicationName: appA });
    const b = await consumerOn(queuesB, { consumerName, applicationName: appB });
    // Conta já commitada: o INSERT … ON CONFLICT dela não serializa ninguém; só o FOR UPDATE serializa.
    await createPlayerAccount(walletId);
    await sendMessage(queuesA.queueUrl, bet.processed.body, { groupId: walletId });
    await sendMessage(queuesB.queueUrl, bet.balance.body, { groupId: walletId });
    // Com o lock: uma grava a metade (presa aqui) e a outra espera a conta.
    // Sem o lock: as duas leem "sem a outra metade" e ficam presas aqui.
    const inserts = await holdHalfInserts(walletId, [bet.processed.eventId, bet.balance.eventId]);
    const observer = await connect("owner");
    let outcomes: string[];
    try {
      const polls = Promise.all([pollUntil(a, 1), pollUntil(b, 1)]);
      await waitForWaitingApps(observer, [appA, appB]);
      await inserts.release();
      outcomes = (await polls).flat();
    } finally {
      await observer.end();
    }

    expect(outcomes).toEqual(["processed", "processed"]);
    expect(await receivedHalves(bet.transactionId)).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    expect((await journalOf(walletId)).map((entry) => [entry.balance_event_id, entry.processed_event_id])).toEqual([
      [bet.balance.eventId, bet.processed.eventId],
    ]);
  }, SLOW_TEST_MS);

  it("D27.4 D27.5: duas metades do mesmo tipo da mesma transação (eventIds diferentes) em duas instâncias, as duas esperando a conta da wallet (pg_locks em accounting.accounts) → um lançamento, a outra intacta na DLQ", async () => {
    const walletId = newId();
    const bet = pair({ walletId, kind: "BET", direction: "DEBIT", amount: "25.00", before: "100.00", after: "75.00", walletVersion: 2 });
    const rival = balanceChanged({
      walletId,
      transactionId: bet.transactionId,
      direction: "DEBIT",
      amount: "25.00",
      before: "100.00",
      after: "75.00",
      walletVersion: 2,
    });
    const [queuesA, queuesB] = [await queuesForTest(), await queuesForTest()];
    const consumerName = `accounting-c-${newId()}`;
    const [appA, appB] = appsFor(walletId);
    const a = await consumerOn(queuesA, { consumerName, applicationName: appA });
    const b = await consumerOn(queuesB, { consumerName, applicationName: appB });
    await sendMessage(queuesA.queueUrl, bet.processed.body, { groupId: walletId });
    expect(await pollUntil(a, 1)).toEqual(["processed"]);

    await sendMessage(queuesA.queueUrl, bet.balance.body, { groupId: walletId });
    await sendMessage(queuesB.queueUrl, rival.body, { groupId: walletId });
    const lock = await holdExistingPlayerAccount(walletId);
    const observer = await connect("owner");
    let outcomes: string[];
    try {
      const polls = Promise.all([pollUntil(a, 1), pollUntil(b, 1)]);
      await waitForPlayerAccountWaiters(observer, [appA, appB]);
      await lock.release();
      outcomes = (await polls).flat().sort();
    } finally {
      await observer.end();
    }

    expect(outcomes).toEqual(["dead_lettered", "processed"]);
    const entries = await journalOf(walletId);
    expect(entries).toHaveLength(1);
    const winner = entries[0]?.balance_event_id;
    const loser = winner === bet.balance.eventId ? rival : winner === rival.eventId ? bet.balance : undefined;
    expect(loser).toBeDefined();
    const deadLettered = [...(await receiveMessages(queuesA.dlqUrl, 1)), ...(await receiveMessages(queuesB.dlqUrl, 1))];
    expect(deadLettered.map((message) => message.Body)).toEqual([loser?.body]);
    expect(await playerAccountBalance(walletId)).toBe("-25.00");
  }, SLOW_TEST_MS);
});

/** Uma submissão que precisa dar o status esperado; devolve o id externo. */
async function expectSubmit(api: ApiClient, wallet: TestWallet, overrides: Record<string, unknown>, status = 200): Promise<string> {
  const body = wagerBody(wallet, overrides);
  const response = await submit(api, body);
  expect({ kind: overrides.kind, status: response.status }).toEqual({ kind: overrides.kind, status });
  return body.externalTransactionId;
}

/**
 * Carga mista numa wallet de 200.00 (D27.7): BETs em paralelo, WINs,
 * REFUND, os dois ROLLBACKs, LOSS e BETs que disputam o saldo (algumas
 * `REJECTED`). Termina com saldo 50.00.
 */
async function mixedLoad(api: ApiClient, wallet: TestWallet): Promise<void> {
  const bets = await Promise.all(Array.from({ length: 5 }, () => expectSubmit(api, wallet, { kind: "BET", money: brl("30.00") })));
  const wins = await Promise.all(Array.from({ length: 2 }, () => expectSubmit(api, wallet, { kind: "WIN", money: brl("20.00") })));
  await Promise.all([
    expectSubmit(api, wallet, { kind: "REFUND", money: brl("30.00"), referenceExternalTransactionId: bets[0] }),
    expectSubmit(api, wallet, { kind: "ROLLBACK", money: brl("30.00"), referenceExternalTransactionId: bets[1] }),
    expectSubmit(api, wallet, { kind: "ROLLBACK", money: brl("20.00"), referenceExternalTransactionId: wins[0] }),
    expectSubmit(api, wallet, { kind: "LOSS", money: brl("0.00"), referenceExternalTransactionId: bets[2] }),
  ]);
  // Saldo 130.00: das três BETs de 80.00 em paralelo, só uma passa.
  const contested = await Promise.all(
    Array.from({ length: 3 }, async () => {
      const response = await submit(api, wagerBody(wallet, { kind: "BET", money: brl("80.00") }));
      return response.status;
    }),
  );
  expect(contested.sort()).toEqual([200, 422, 422]);
}

/** As linhas JSON (pino) de um processo com a mensagem dada. */
function logEntries(process: Pick<TestProcess, "lines">, msg: string): Record<string, unknown>[] {
  return process.lines
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.msg === msg);
}

describe("D27.6 D27.7: reconciliação depois de uma carga, com instâncias em processos separados", () => {
  let topic: TestTopic;
  let queues: TestQueues;
  let group: ProcessGroup;

  beforeEach(async () => {
    await parkAllOutbox();
    topic = await createTestTopic();
    queues = await createTestQueues();
    await subscribeQueue(topic, queues.queueUrl);
    group = new ProcessGroup("accounting-carga");
  });

  afterEach(async () => {
    await group.close();
    await queues.destroy();
    await topic.destroy();
  });

  it("D27.4 D27.6 D27.7 R-11-03: 10 wallets com carga mista, 2 outbox-publisher e 2 accounting-consumer em processos separados (os dois lançam), mais duplicatas injetadas (todas reconhecidas na inbox, DLQ vazia) → todas consistentes, trial balance zero, um lançamento por lançamento do núcleo", async () => {
    const accountingEnv = accountingProcessEnv(queues);
    const [, , accounting1, accounting2] = await Promise.all([
      group.spawn("outbox-publisher", { instance: "acc-publisher-1", env: { SNS_TOPIC_WAGERING_EVENTS: topic.topicName } }),
      group.spawn("outbox-publisher", { instance: "acc-publisher-2", env: { SNS_TOPIC_WAGERING_EVENTS: topic.topicName } }),
      group.spawn("accounting-consumer", { instance: "accounting-1", env: accountingEnv }),
      group.spawn("accounting-consumer", { instance: "accounting-2", env: accountingEnv }),
    ]);
    const accountingProcesses = [accounting1, accounting2];

    const api = await startTestApi();
    let walletIds: string[];
    try {
      const wallets = await Promise.all(Array.from({ length: 10 }, () => createWallet(api, brl("200.00"))));
      walletIds = wallets.map((wallet) => wallet.id);
      await Promise.all(wallets.map((wallet) => mixedLoad(api, wallet)));
    } finally {
      await api.close();
    }

    await waitFor(async () => (await unpublishedCount(walletIds)) === 0, "outbox da carga publicada", 60_000);
    await waitFor(async () => (await reconcileWallets(walletIds)).settled, "accounting em dia com o núcleo", 90_000);

    // D27.6: as duas instâncias trabalharam (cada uma gravou pelo menos um lançamento).
    expect(accountingProcesses.map((process) => logEntries(process, "lançamento gravado no diário").length > 0)).toEqual([true, true]);

    // Duplicatas: os envelopes já consumidos, de novo na fila, fora da janela de deduplicação.
    const payloads = await withClient("app", async (client) => {
      const { rows } = await client.query<{ ordering_key: string; payload: string }>(
        `SELECT ordering_key, payload::text AS payload FROM outbox_messages
          WHERE ordering_key = ANY($1::uuid[]) AND event_type IN ('WalletBalanceChanged', 'WagerTransactionProcessed')
          ORDER BY position`,
        [walletIds],
      );
      return rows;
    });
    const injected = payloads.slice(0, 30);
    const injectedIds = injected.map((row) => (JSON.parse(row.payload) as { eventId: string }).eventId);
    for (const [index, row] of injected.entries()) {
      await sendMessage(queues.queueUrl, row.payload, { groupId: row.ordering_key, deduplicationId: `dup-${index}` });
    }
    await waitFor(async () => {
      const counts = await queueCounts(queues.queueUrl);
      return counts.visible === 0 && counts.inFlight === 0;
    }, "duplicatas consumidas", 60_000);
    // O log da duplicata sai depois do ack: espera cada eventId injetado aparecer como duplicata.
    const duplicatesSeen = () =>
      new Set(accountingProcesses.flatMap((process) => logEntries(process, "mensagem duplicada (inbox)").map((entry) => entry.messageId)));
    await waitFor(async () => injectedIds.every((id) => duplicatesSeen().has(id)), "duplicatas reconhecidas na inbox", 10_000);
    expect(await queueCounts(queues.dlqUrl)).toEqual({ visible: 0, inFlight: 0 });

    const report = await reconcileWallets(walletIds);
    expect(report.wallets.filter((wallet) => wallet.status !== "consistent")).toEqual([]);
    expect(report.trialBalance.filter((row) => !row.balanced)).toEqual([]);
    expect(report.consistent).toBe(true);
    expect(report.settled).toBe(true);
    for (const walletId of walletIds) expect(await playerAccountBalance(walletId)).toBe("50.00");

    const [core, journal] = await Promise.all([
      withClient("app", async (client) => {
        const { rows } = await client.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ANY($1::uuid[])",
          [walletIds],
        );
        return rows[0]?.n;
      }),
      withClient("accounting", async (client) => {
        const { rows } = await client.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM accounting.journal_entries WHERE wallet_id = ANY($1::uuid[])",
          [walletIds],
        );
        return rows[0]?.n;
      }),
    ]);
    expect(journal).toBe(core);
    await expectLedgerMatchesBalances();
  }, LOAD_TEST_MS);
});

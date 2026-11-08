import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Client } from "pg";
import {
  journalOf,
  pair,
  playerAccountBalance,
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
import { ProcessGroup, waitFor } from "../support/processes";
import { createTestQueues, queueCounts, sendMessage, type TestQueues } from "../support/sqs";
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

/**
 * Conta da wallet criada e commitada, depois travada (`FOR UPDATE`) numa
 * transação aberta: os consumidores esperam na linha da conta (D27.4).
 */
async function holdExistingPlayerAccount(walletId: string): Promise<{ release(): Promise<void> }> {
  await withClient("accounting", (client) =>
    client.query(
      `INSERT INTO accounting.accounts (id, code, nature, currency, wallet_id)
       VALUES ($1, 'PLAYER_WALLET', 'LIABILITY', 'BRL', $2) ON CONFLICT (wallet_id) DO NOTHING`,
      [newId(), walletId],
    ),
  );
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

/** Espera, por `pg_locks`, as sessões dos `applicationNames` dados esperando um lock (estado observável, sem `sleep`). */
async function waitForWaitingApps(observer: Client, applicationNames: string[]): Promise<void> {
  await waitFor(
    async () => {
      const { rows } = await observer.query<{ app: string }>(
        `SELECT DISTINCT a.application_name AS app
           FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE NOT l.granted AND a.application_name = ANY($1)`,
        [applicationNames],
      );
      return rows.length === applicationNames.length;
    },
    `${applicationNames.join(" e ")} esperando lock`,
    10_000,
  );
}

describe("D27.4: duas instâncias do accounting ao mesmo tempo", () => {
  it("D27.4 R-11-03: a mesma metade em duas instâncias, as duas esperando a conta da wallet → um lançamento (a outra cai na inbox)", async () => {
    const walletId = newId();
    const bet = pair({ walletId, kind: "BET", direction: "DEBIT", amount: "25.00", before: "100.00", after: "75.00", walletVersion: 2 });
    const [queuesA, queuesB] = [await queuesForTest(), await queuesForTest()];
    const consumerName = `accounting-c-${newId()}`;
    const a = await consumerOn(queuesA, { consumerName, applicationName: `acc-a-${walletId.slice(-8)}` });
    const b = await consumerOn(queuesB, { consumerName, applicationName: `acc-b-${walletId.slice(-8)}` });
    await sendMessage(queuesA.queueUrl, bet.processed.body, { groupId: walletId });
    expect(await pollUntil(a, 1)).toEqual(["processed"]);

    await sendMessage(queuesA.queueUrl, bet.balance.body, { groupId: walletId });
    await sendMessage(queuesB.queueUrl, bet.balance.body, { groupId: walletId });
    const lock = await holdExistingPlayerAccount(walletId);
    const observer = await connect("owner");
    let outcomes: string[];
    try {
      const polls = Promise.all([pollUntil(a, 1), pollUntil(b, 1)]);
      await waitForWaitingApps(observer, [`acc-a-${walletId.slice(-8)}`, `acc-b-${walletId.slice(-8)}`]);
      await lock.release();
      outcomes = (await polls).flat().sort();
    } finally {
      await observer.end();
    }

    expect(outcomes).toEqual(["duplicate", "processed"]);
    expect(await journalOf(walletId)).toHaveLength(1);
    expect(await playerAccountBalance(walletId)).toBe("-25.00");
  }, SLOW_TEST_MS);

  it("D27.4: as duas metades do mesmo par em duas instâncias, as duas esperando a conta da wallet → exatamente um lançamento", async () => {
    const walletId = newId();
    const bet = pair({ walletId, kind: "BET", direction: "DEBIT", amount: "25.00", before: "100.00", after: "75.00", walletVersion: 2 });
    const [queuesA, queuesB] = [await queuesForTest(), await queuesForTest()];
    const consumerName = `accounting-c-${newId()}`;
    const appA = `acc-a-${walletId.slice(-8)}`;
    const appB = `acc-b-${walletId.slice(-8)}`;
    const a = await consumerOn(queuesA, { consumerName, applicationName: appA });
    const b = await consumerOn(queuesB, { consumerName, applicationName: appB });
    await sendMessage(queuesA.queueUrl, bet.processed.body, { groupId: walletId });
    await sendMessage(queuesB.queueUrl, bet.balance.body, { groupId: walletId });
    const lock = await holdExistingPlayerAccount(walletId);
    const observer = await connect("owner");
    let outcomes: string[];
    try {
      const polls = Promise.all([pollUntil(a, 1), pollUntil(b, 1)]);
      await waitForWaitingApps(observer, [appA, appB]);
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

  it("D27.4 D27.6 D27.7 R-11-03: 10 wallets com carga mista, 2 outbox-publisher e 2 accounting-consumer em processos separados, mais duplicatas injetadas → todas consistentes, trial balance zero, um lançamento por lançamento do núcleo", async () => {
    const accountingEnv = accountingProcessEnv(queues);
    await Promise.all([
      group.spawn("outbox-publisher", { instance: "acc-publisher-1", env: { SNS_TOPIC_WAGERING_EVENTS: topic.topicName } }),
      group.spawn("outbox-publisher", { instance: "acc-publisher-2", env: { SNS_TOPIC_WAGERING_EVENTS: topic.topicName } }),
      group.spawn("accounting-consumer", { instance: "accounting-1", env: accountingEnv }),
      group.spawn("accounting-consumer", { instance: "accounting-2", env: accountingEnv }),
    ]);

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
    for (const [index, row] of payloads.slice(0, 30).entries()) {
      await sendMessage(queues.queueUrl, row.payload, { groupId: row.ordering_key, deduplicationId: `dup-${index}` });
    }
    await waitFor(async () => {
      const counts = await queueCounts(queues.queueUrl);
      return counts.visible === 0 && counts.inFlight === 0;
    }, "duplicatas consumidas", 60_000);

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

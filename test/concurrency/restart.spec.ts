import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { WalletBody } from "../support/api";
import { auditedRows } from "../support/auditor";
import { startTestIssuer, type TestIssuer } from "../support/auth";
import { effectsOf, wagerMessage } from "../support/consumer";
import { connect, withClient } from "../support/db";
import { expectLedgerMatchesBalances } from "../support/db-ledger-invariant";
import {
  createTestTopic,
  outboxIdsOf,
  parkAllOutbox,
  subscribeQueue,
  type TestTopic,
  unpublishedCount,
} from "../support/outbox";
import { apiClient, authEnv, ProcessGroup, type TestProcess, waitFor, walletLockWaiterApps } from "../support/processes";
import { createTestQueues, queueCounts, sendMessage, type TestQueues } from "../support/sqs";
import {
  type ApiClient,
  brl,
  createWallet,
  holdWalletLock,
  type SubmissionInput,
  submit,
  type TestWallet,
  WAITERS_DEADLINE_MS,
  wagerBody,
} from "../support/wagering";

/** A topologia inteira em processos, dois reinícios de lease (5 s) e a visibilidade (10 s). */
const SLOW_TEST_MS = 180_000;
const WALLETS = 4;

/**
 * Prazos curtos nos processos do teste (D21.6), com as contas validadas
 * na subida: lote 2 × 2 s < lease de 5 s; 1 mensagem × 7 s ≤ 10 s; SNS de
 * 2 s < lease de 5 s.
 */
const SHORT_LEASES = {
  PENDING_LEASE_MS: "5000",
  PENDING_BATCH_SIZE: "2",
  CONSUMER_VISIBILITY_TIMEOUT_S: "10",
  CONSUMER_MAX_MESSAGES: "1",
  OUTBOX_LEASE_MS: "5000",
  OUTBOX_SNS_REQUEST_TIMEOUT_MS: "2000",
};

let issuer: TestIssuer;
let transactions: TestQueues;
let auditorQueues: TestQueues;
let topic: TestTopic;
let group: ProcessGroup;

beforeEach(async () => {
  issuer = await startTestIssuer();
  transactions = await createTestQueues();
  auditorQueues = await createTestQueues();
  topic = await createTestTopic();
  await subscribeQueue(topic, auditorQueues.queueUrl);
  await parkAllOutbox();
  group = new ProcessGroup("r-13-c8");
});

afterEach(async () => {
  await group.close();
  await Promise.all([transactions.destroy(), auditorQueues.destroy(), topic.destroy()]);
  await issuer.stop();
});

/**
 * O provedor reenvia (mesma key) para outra instância quando a conexão
 * cai ou a resposta é `503` (D3.4, D16.3): um reinício nunca perde nem
 * duplica a operação.
 */
async function submitResilient(
  apis: readonly ApiClient[],
  first: number,
  body: SubmissionInput,
): Promise<Awaited<ReturnType<typeof submit>>> {
  const deadline = Date.now() + 60_000;
  for (let attempt = first; ; attempt++) {
    const api = apis[attempt % apis.length] as ApiClient;
    try {
      const response = await submit(api, body);
      if (response.status !== 503) return response;
    } catch (error) {
      // Conexão derrubada pelo kill (ou recusada enquanto reinicia): é o
      // caso que o teste provoca; o provedor tenta a próxima instância.
      if (!(error instanceof Error) || Date.now() > deadline) throw error;
    }
    if (Date.now() > deadline) throw new Error("a submissão não passou em 60 s de reenvios");
  }
}

interface WalletPlan {
  wallet: TestWallet;
  bet1: SubmissionInput;
  bet2: SubmissionInput;
  win1: SubmissionInput;
  refund2: SubmissionInput;
  queuedBet: ReturnType<typeof wagerMessage>;
  /** A `bet1` de novo, pela fila (outro `messageId`, mesma key): replay. */
  bet1AgainByQueue: ReturnType<typeof wagerMessage>;
}

function planFor(wallet: TestWallet): WalletPlan {
  const bet1 = wagerBody(wallet, { money: brl("10.00") });
  const bet2 = wagerBody(wallet, { money: brl("10.00") });
  return {
    wallet,
    bet1,
    bet2,
    win1: wagerBody(wallet, {
      kind: "WIN",
      money: brl("5.00"),
      referenceExternalTransactionId: bet1.externalTransactionId,
    }),
    refund2: wagerBody(wallet, {
      kind: "REFUND",
      money: brl("10.00"),
      referenceExternalTransactionId: bet2.externalTransactionId,
    }),
    queuedBet: wagerMessage(wallet, { data: { money: brl("10.00") } }),
    bet1AgainByQueue: wagerMessage(wallet, {
      data: { externalTransactionId: bet1.externalTransactionId, money: brl("10.00") },
    }),
  };
}

async function pendingCount(walletIds: readonly string[]): Promise<number> {
  return withClient("app", async (client) => {
    const { rows } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = ANY($1::uuid[]) AND status = 'PENDING_REFERENCE'",
      [walletIds],
    );
    return rows[0]?.n ?? 0;
  });
}

describe("R-13-C8 R-13-I6 D7.4 D21.5: reinício no meio da carga", () => {
  it("R-13-C8 R-13-I6 D21.2 D21.5: topologia D7.4 em processos; api, consumer, worker e publisher mortos à força no meio da carga e reiniciados → fila vazia, nenhuma pendente, outbox publicada e auditada em ordem, reconciliação consistent: true em todas as wallets do teste", async () => {
    const env = {
      ...authEnv(issuer),
      ...SHORT_LEASES,
      QUEUE_WAGER_TRANSACTIONS: transactions.queueName,
      QUEUE_WAGER_TRANSACTIONS_DLQ: transactions.dlqName,
      SNS_TOPIC_WAGERING_EVENTS: topic.topicName,
      QUEUE_WAGERING_EVENTS_AUDITOR: auditorQueues.queueName,
      QUEUE_WAGERING_EVENTS_AUDITOR_DLQ: auditorQueues.dlqName,
    };
    const spawn = (kind: TestProcess["kind"], instance: string) => group.spawn(kind, { instance, env });
    const [api1, api2, api3, consumer1, , , worker1, , publisher1] = await Promise.all([
      spawn("api", "api-1"),
      spawn("api", "api-2"),
      spawn("api", "api-3"),
      spawn("consumer", "consumer-1"),
      spawn("consumer", "consumer-2"),
      spawn("consumer", "consumer-3"),
      spawn("pending-worker", "worker-1"),
      spawn("pending-worker", "worker-2"),
      spawn("outbox-publisher", "publisher-1"),
      spawn("outbox-publisher", "publisher-2"),
      spawn("event-auditor", "auditor-1"),
    ]);
    if (!api1 || !api2 || !api3 || !consumer1 || !worker1 || !publisher1) throw new Error("topologia incompleta");
    const apis = [api1, api2, api3].map((p) => apiClient(p, issuer));

    const plans = await Promise.all(
      Array.from({ length: WALLETS }, async () => planFor(await createWallet(apis[0] as ApiClient, brl("1000.00")))),
    );
    const walletIds = plans.map((p) => p.wallet.id);

    // 1ª metade: BET, REFUND antes da BET que ele reverte (fica pendente) e uma BET pela fila.
    const firstHalf = await Promise.all(
      plans.flatMap((plan, i) => [submitResilient(apis, i, plan.bet1), submitResilient(apis, i + 1, plan.refund2)]),
    );
    expect(firstHalf.map((r) => r.status).sort()).toEqual([...Array(WALLETS).fill(200), ...Array(WALLETS).fill(202)]);
    await Promise.all(
      plans.map((plan) => sendMessage(transactions.queueUrl, plan.queuedBet.body, { groupId: plan.wallet.id })),
    );

    // 2ª metade, com a 1ª wallet travada: a requisição dela fica em voo na
    // api-2 (visto no pg_locks) quando os processos são mortos.
    const [held] = plans;
    if (!held) throw new Error("sem wallets");
    const lock = await holdWalletLock(held.wallet.id);
    const observer = await connect("app");
    let secondHalf: Promise<Awaited<ReturnType<typeof submit>>[]>;
    try {
      secondHalf = Promise.all(
        plans.flatMap((plan) => [submitResilient(apis, 1, plan.bet2), submitResilient(apis, 2, plan.win1)]),
      );
      await Promise.all(
        plans.map((plan) => sendMessage(transactions.queueUrl, plan.bet1AgainByQueue.body, { groupId: plan.wallet.id })),
      );
      await waitFor(
        async () => (await walletLockWaiterApps(observer, lock)).includes("api-2"),
        "a api-2 esperando a wallet travada",
        WAITERS_DEADLINE_MS,
      );
      await Promise.all([api2.kill(), consumer1.kill(), worker1.kill(), publisher1.kill()]);
      await lock.release();
      await Promise.all([api2.restart(), consumer1.restart(), worker1.restart(), publisher1.restart()]);
    } finally {
      await lock.release();
      await observer.end();
    }
    const second = await secondHalf;
    expect(second.map((r) => r.status)).toEqual(second.map(() => 200));

    // Consistência final: fila vazia, nenhuma pendente, outbox publicada e auditada.
    await waitFor(
      async () => {
        const counts = await queueCounts(transactions.queueUrl);
        if (counts.visible + counts.inFlight > 0) return false;
        if ((await pendingCount(walletIds)) > 0) return false;
        if ((await unpublishedCount(walletIds)) > 0) return false;
        const ids = (await Promise.all(walletIds.map(outboxIdsOf))).flat();
        return (await auditedRows(ids)).length === ids.length;
      },
      "a topologia convergir depois dos reinícios",
      120_000,
    );

    expect((await queueCounts(transactions.dlqUrl)).visible).toBe(0);
    expect((await queueCounts(auditorQueues.dlqUrl)).visible).toBe(0);
    for (const plan of plans) {
      for (const body of [plan.bet1, plan.bet2, plan.win1, plan.refund2]) {
        const effects = await effectsOf("provider-a", body.externalTransactionId);
        expect(effects.transactions.map((t) => t.status)).toEqual(["PROCESSED"]);
        expect(effects.entries).toHaveLength(1);
      }
      const queued = await effectsOf("provider-a", plan.queuedBet.externalTransactionId);
      expect(queued.transactions.map((t) => t.status)).toEqual(["PROCESSED"]);
      expect(queued.entries).toEqual([{ direction: "DEBIT", amount: "10.00" }]);

      // 1000 − 10 (bet1) − 10 (bet2) + 5 (win1) + 10 (refund2) − 10 (fila) = 985.
      const view = (await (await (apis[2] as ApiClient).request("GET", `/wallets/${plan.wallet.id}`)).json()) as WalletBody;
      expect(view.balance).toEqual(brl("985.00"));
      // A OPENING é a versão 1 (D6.2); os 5 movimentos, 2 a 6.
      expect(view.version).toBe(6);

      const reconciliation = await (apis[0] as ApiClient).request("POST", `/wallets/${plan.wallet.id}/reconciliation`);
      expect(reconciliation.status).toBe(200);
      expect(((await reconciliation.json()) as { consistent: boolean }).consistent).toBe(true);
    }
    const audited = await auditedRows((await Promise.all(walletIds.map(outboxIdsOf))).flat());
    expect(audited.filter((row) => row.in_order === false)).toEqual([]);
    await expectLedgerMatchesBalances();
  }, SLOW_TEST_MS);
});

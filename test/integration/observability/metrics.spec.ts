import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { UnitOfWork } from "../../../src/modules/wagering/application/ports";
import { SqsWagerQueue } from "../../../src/modules/wagering/infra/messaging/sqs-wager-queue";
import { trackDlqDepth, trackOutboxBacklog } from "../../../src/modules/wagering/infra/observability/gauges";
import { WAGERING_ENTITIES } from "../../../src/modules/wagering/infra/persistence";
import { MikroOrmOutboxStore } from "../../../src/modules/wagering/infra/persistence/outbox-store";
import { TransientError } from "../../../src/shared/errors/app-errors";
import { logger } from "../../../src/shared/logger/logger";
import { METRIC_LABEL_VALUES } from "../../../src/shared/metrics/metrics";
import { createOrm } from "../../../src/shared/orm/create-orm";
import { startTestApi, type TestApi } from "../../support/api";
import { envelopeJson, startTestAuditor } from "../../support/auditor";
import { startTestConsumer, type TestConsumer, wagerMessage } from "../../support/consumer";
import { connect, credentialsFor, newId, withClient } from "../../support/db";
import { expectLedgerMatchesBalances } from "../../support/db-ledger-invariant";
import { histogram, metricValue, observedLabelValues } from "../../support/metrics";
import { createTestTopic, insertOutboxEvent, parkAllOutbox, startTestPublisher } from "../../support/outbox";
import { createTestQueues, sendMessage, type TestQueues, testSqsClient } from "../../support/sqs";
import {
  brl,
  createWallet,
  holdWalletLock,
  newExternalId,
  submit,
  type TestWallet,
  waitForWalletLockWaiters,
  wagerBody,
} from "../../support/wagering";
import { parkPendings, pendingRow, runWorkerUntil, startTestWorker } from "../../support/worker";

/**
 * R-12-03 D11.2 D22: cada situação da lista mínima dispara e a métrica
 * correspondente muda. As métricas são do registry do processo de teste:
 * a API, o consumidor, o worker e o publisher sobem aqui dentro, com os
 * adaptadores de produção.
 */

/** Testes que esperam o `lock_timeout` (2 s), filas ou o worker: o padrão de 5 s do bun não cabe. */
const SLOW_TEST_MS = 30_000;

let api: TestApi;
const queuesToDestroy: TestQueues[] = [];
const closers: (() => Promise<void>)[] = [];
const pendings: string[] = [];

beforeAll(async () => {
  api = await startTestApi();
});

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const queues of queuesToDestroy.splice(0)) await queues.destroy();
  await withClient("app", (client) => parkPendings(client, pendings));
});

afterAll(async () => {
  await api.close();
  // Todo teste que move dinheiro termina com o invariante (CLAUDE.md, D11.4).
  await expectLedgerMatchesBalances();
});

async function queues(): Promise<TestQueues> {
  const created = await createTestQueues();
  queuesToDestroy.push(created);
  return created;
}

async function consumerOn(target: TestQueues, options: Parameters<typeof startTestConsumer>[1] = {}): Promise<TestConsumer> {
  const consumer = await startTestConsumer(target, options);
  closers.push(() => consumer.close());
  return consumer;
}

const transactions = (status: string, kind: string, channel: string) =>
  metricValue("wagering_transactions_total", { status, kind, channel });

/** Erro transitório só para o teste: o `classifyError()` o trata como `503`/retry (D5). */
class TestTransientError extends TransientError {
  constructor() {
    super("falha transitória injetada pelo teste");
  }
}

/** Unidade de trabalho cuja 1ª chamada falha com transitório; as seguintes passam. */
function failingOnce(): (uow: UnitOfWork) => UnitOfWork {
  return (uow) => {
    let failed = false;
    return {
      run(work, options) {
        if (!failed) {
          failed = true;
          return Promise.reject(new TestTransientError());
        }
        return uow.run(work, options);
      },
    };
  };
}

describe("R-12-03 D22.2: transações por status, kind e canal", () => {
  it("R-12-03 D22.2: HTTP PROCESSED, REJECTED e PENDING_REFERENCE contam com channel=http; replay não conta", async () => {
    const wallet = await createWallet(api, brl("100.00"));
    const before = {
      processed: await transactions("PROCESSED", "BET", "http"),
      rejected: await transactions("REJECTED", "BET", "http"),
      pending: await transactions("PENDING_REFERENCE", "REFUND", "http"),
    };

    const bet = wagerBody(wallet, { money: brl("10.00") });
    expect((await submit(api, bet)).status).toBe(200);
    expect((await submit(api, bet)).body.idempotentReplay).toBe(true);
    expect((await submit(api, wagerBody(wallet, { money: brl("500.00") }))).status).toBe(422);
    const pending = await submit(
      api,
      wagerBody(wallet, { kind: "REFUND", referenceExternalTransactionId: newExternalId("ausente") }),
    );
    expect(pending.status).toBe(202);
    pendings.push(pending.body.transactionId);

    expect(await transactions("PROCESSED", "BET", "http")).toBe(before.processed + 1);
    expect(await transactions("REJECTED", "BET", "http")).toBe(before.rejected + 1);
    expect(await transactions("PENDING_REFERENCE", "REFUND", "http")).toBe(before.pending + 1);
  });

  it("R-12-03 D22.2: a OPENING conta como PROCESSED, kind OPENING, channel=http", async () => {
    const before = await transactions("PROCESSED", "OPENING", "http");

    await createWallet(api, brl("50.00"));

    expect(await transactions("PROCESSED", "OPENING", "http")).toBe(before + 1);
  });

  it(
    "R-12-03 D22.2: pela fila conta com channel=sqs",
    async () => {
      const target = await queues();
      const consumer = await consumerOn(target);
      const wallet = await createWallet(api, brl("100.00"));
      const before = await transactions("PROCESSED", "BET", "sqs");

      await sendMessage(target.queueUrl, wagerMessage(wallet).body, { groupId: wallet.id });
      expect(await consumer.pollOnce()).toEqual(["processed"]);

      expect(await transactions("PROCESSED", "BET", "sqs")).toBe(before + 1);
    },
    SLOW_TEST_MS,
  );

  it(
    "R-12-03 D22.2: pendente resolvida pelo worker conta com channel=worker",
    async () => {
      const worker = await startTestWorker();
      closers.push(() => worker.close());
      const wallet = await createWallet(api, brl("100.00"));
      const betId = newExternalId("bet");
      const refund = await submit(api, wagerBody(wallet, { kind: "REFUND", referenceExternalTransactionId: betId }));
      expect(refund.status).toBe(202);
      pendings.push(refund.body.transactionId);
      expect((await submit(api, wagerBody(wallet, { externalTransactionId: betId }))).status).toBe(200);
      const before = await transactions("PROCESSED", "REFUND", "worker");

      await runWorkerUntil(worker, async () => (await pendingRow(refund.body.transactionId)).status === "PROCESSED");

      expect(await transactions("PROCESSED", "REFUND", "worker")).toBe(before + 1);
    },
    SLOW_TEST_MS,
  );
});

describe("R-12-03 D17.7: duplicatas por camada", () => {
  it(
    "R-12-03 D17.7: replay HTTP conta fast_path; a mesma mensagem duas vezes conta inbox",
    async () => {
      const target = await queues();
      const consumer = await consumerOn(target);
      const wallet = await createWallet(api, brl("100.00"));
      const before = {
        fastPath: await metricValue("wagering_duplicates_total", { layer: "fast_path" }),
        inbox: await metricValue("wagering_duplicates_total", { layer: "inbox" }),
      };

      const bet = wagerBody(wallet);
      await submit(api, bet);
      await submit(api, bet);
      const message = wagerMessage(wallet);
      await sendMessage(target.queueUrl, message.body, { groupId: wallet.id, deduplicationId: "a" });
      expect(await consumer.pollOnce()).toEqual(["processed"]);
      await sendMessage(target.queueUrl, message.body, { groupId: wallet.id, deduplicationId: "b" });
      expect(await consumer.pollOnce()).toEqual(["duplicate"]);

      expect(await metricValue("wagering_duplicates_total", { layer: "fast_path" })).toBe(before.fastPath + 1);
      expect(await metricValue("wagering_duplicates_total", { layer: "inbox" })).toBe(before.inbox + 1);
    },
    SLOW_TEST_MS,
  );
});

describe("R-12-03 D22.3: retries por componente", () => {
  it(
    "R-12-03 D22.3: transitório no consumidor → retry de consumer",
    async () => {
      const target = await queues();
      const consumer = await consumerOn(target, { wrapUow: failingOnce() });
      const wallet = await createWallet(api, brl("100.00"));
      const before = await metricValue("wagering_retries_total", { component: "consumer" });

      await sendMessage(target.queueUrl, wagerMessage(wallet).body, { groupId: wallet.id });
      expect(await consumer.pollOnce()).toEqual(["retry_scheduled"]);
      expect(await consumer.pollOnce()).toEqual(["processed"]);

      expect(await metricValue("wagering_retries_total", { component: "consumer" })).toBe(before + 1);
    },
    SLOW_TEST_MS,
  );

  it(
    "R-12-03 D22.3: erro numa tentativa do worker → retry de pending_worker",
    async () => {
      const worker = await startTestWorker({ wrapUow: failingOnce() });
      closers.push(() => worker.close());
      const wallet = await createWallet(api, brl("100.00"));
      const refund = await submit(
        api,
        wagerBody(wallet, { kind: "REFUND", referenceExternalTransactionId: newExternalId("ausente") }),
      );
      pendings.push(refund.body.transactionId);
      const before = await metricValue("wagering_retries_total", { component: "pending_worker" });

      await runWorkerUntil(worker, async () => (await pendingRow(refund.body.transactionId)).attempts >= 1);

      expect(await metricValue("wagering_retries_total", { component: "pending_worker" })).toBe(before + 1);
    },
    SLOW_TEST_MS,
  );

  it(
    "R-12-03 D22.3: falha ao publicar → retry de outbox_publisher",
    async () => {
      const topic = await createTestTopic();
      closers.push(() => topic.destroy());
      await parkAllOutbox();
      const event = await withClient("app", (client) => insertOutboxEvent(client, { walletId: newId(), walletVersion: 2 }));
      const publisher = await startTestPublisher(topic, {
        wrapSns: () => ({ send: () => Promise.reject(new TestTransientError()) }),
      });
      closers.push(() => publisher.close());
      const before = await metricValue("wagering_retries_total", { component: "outbox_publisher" });

      const round = await publisher.runOnce();

      expect(round.failed).toEqual([event.id]);
      expect(await metricValue("wagering_retries_total", { component: "outbox_publisher" })).toBe(before + 1);
      await parkAllOutbox();
    },
    SLOW_TEST_MS,
  );
});

describe("R-12-03 D22.4: mensagens na DLQ por motivo e profundidade", () => {
  it(
    "R-12-03 D22.4: mensagem inválida → DLQ{wager_transactions, VALIDATION_ERROR} e sqs_dlq_depth no scrape",
    async () => {
      const target = await queues();
      const consumer = await consumerOn(target);
      const sqs = testSqsClient();
      const stopTracking = trackDlqDepth("wager_transactions_dlq", new SqsWagerQueue(sqs, target), logger, 1000);
      closers.push(async () => {
        stopTracking();
        sqs.destroy();
      });
      const before = await metricValue("wagering_dlq_messages_total", {
        consumer: "wager_transactions",
        reason: "VALIDATION_ERROR",
      });

      await sendMessage(target.queueUrl, "{ isto não é json", { groupId: "g-1" });
      expect(await consumer.pollOnce()).toEqual(["dead_lettered"]);

      expect(
        await metricValue("wagering_dlq_messages_total", { consumer: "wager_transactions", reason: "VALIDATION_ERROR" }),
      ).toBe(before + 1);
      expect(await metricValue("sqs_dlq_depth", { queue: "wager_transactions_dlq" })).toBe(1);
    },
    SLOW_TEST_MS,
  );

  it(
    "R-12-03 D22.4: envelope inválido no auditor → DLQ{event_auditor, VALIDATION_ERROR}",
    async () => {
      const target = await queues();
      const auditor = await startTestAuditor(target);
      closers.push(() => auditor.close());
      const before = await metricValue("wagering_dlq_messages_total", {
        consumer: "event_auditor",
        reason: "VALIDATION_ERROR",
      });

      const broken = envelopeJson({ walletId: newId(), data: {} }).body.replace('"eventType"', '"semTipo"');
      await sendMessage(target.queueUrl, broken, { groupId: "g-1" });
      expect(await auditor.pollOnce()).toEqual(["dead_lettered"]);

      expect(
        await metricValue("wagering_dlq_messages_total", { consumer: "event_auditor", reason: "VALIDATION_ERROR" }),
      ).toBe(before + 1);
    },
    SLOW_TEST_MS,
  );
});

describe("R-12-03 D22.5: conflitos de lock e tempo de espera", () => {
  it(
    "R-12-03 D22.5: a espera pelo lock da wallet entra no histograma",
    async () => {
      const wallet = await createWallet(api, brl("100.00"));
      const before = await histogram("wallet_lock_wait_seconds");
      const lock = await holdWalletLock(wallet.id);
      const observer = await connect("app");
      let heldMs = 0;
      try {
        const submission = submit(api, wagerBody(wallet));
        await waitForWalletLockWaiters(observer, lock, 1);
        const seenAt = performance.now();
        await lock.release();
        heldMs = performance.now() - seenAt;
        expect((await submission).status).toBe(200);
      } finally {
        await lock.release();
        await observer.end();
      }

      const after = await histogram("wallet_lock_wait_seconds");
      expect(after.count).toBeGreaterThanOrEqual(before.count + 1);
      // A espera durou, no mínimo, do waiter visto no pg_locks até o lock ser solto.
      expect(after.sum - before.sum).toBeGreaterThanOrEqual(heldMs / 1000 - 0.001);
    },
    SLOW_TEST_MS,
  );

  it(
    "R-12-03 D22.5 D5: lock_timeout → 503 e wallet_lock_conflicts_total{lock_timeout}",
    async () => {
      const wallet = await createWallet(api, brl("100.00"));
      const before = await metricValue("wallet_lock_conflicts_total", { reason: "lock_timeout" });
      const lock = await holdWalletLock(wallet.id);
      try {
        const response = await submit(api, wagerBody(wallet));
        expect(response.status).toBe(503);
      } finally {
        await lock.release();
      }

      expect(await metricValue("wallet_lock_conflicts_total", { reason: "lock_timeout" })).toBe(before + 1);
    },
    SLOW_TEST_MS,
  );
});

describe("R-12-03 D22.6: outbox lag e quantidade pendente", () => {
  it("R-12-03 D22.6: um evento não publicado de 42 s → pending 1 e lag ≥ 42 no scrape; publicado → 0 e 0", async () => {
    const orm: MikroORM = await createOrm({ credentials: await credentialsFor("app"), entities: WAGERING_ENTITIES });
    const stopTracking = trackOutboxBacklog(new MikroOrmOutboxStore(orm), logger, 1000);
    closers.push(async () => {
      stopTracking();
      await orm.close();
    });
    await parkAllOutbox();
    const walletId = newId();
    await withClient("app", (client) =>
      client.query(
        `INSERT INTO outbox_messages (id, aggregate_id, ordering_key, event_type, payload, occurred_at, next_attempt_at)
         VALUES ($1, $2, $2, 'WalletBalanceChanged', '{}'::jsonb, now() - interval '42 seconds', now() + interval '1 day')`,
        [newId(), walletId],
      ),
    );

    expect(await metricValue("outbox_pending_events")).toBe(1);
    expect(await metricValue("outbox_lag_seconds")).toBeGreaterThanOrEqual(42);

    await parkAllOutbox();
    expect(await metricValue("outbox_pending_events")).toBe(0);
    expect(await metricValue("outbox_lag_seconds")).toBe(0);
  });
});

describe("R-12-03 D22.7: latência de processamento", () => {
  it(
    "R-12-03 D22.7: HTTP ok e error, SQS e worker entram no histograma pelo canal",
    async () => {
      const target = await queues();
      const consumer = await consumerOn(target);
      const worker = await startTestWorker();
      closers.push(() => worker.close());
      const wallet = await createWallet(api, brl("100.00"));
      const before = {
        httpOk: await histogram("wagering_processing_duration_seconds", { channel: "http", outcome: "ok" }),
        httpError: await histogram("wagering_processing_duration_seconds", { channel: "http", outcome: "error" }),
        sqs: await histogram("wagering_processing_duration_seconds", { channel: "sqs", outcome: "ok" }),
        worker: await histogram("wagering_processing_duration_seconds", { channel: "worker", outcome: "ok" }),
      };

      await submit(api, wagerBody(wallet));
      // Wallet inexistente: o use case lança (404), outcome=error.
      expect((await submit(api, wagerBody({ id: newId(), playerId: wallet.playerId }))).status).toBe(404);
      await sendMessage(target.queueUrl, wagerMessage(wallet).body, { groupId: wallet.id });
      expect(await consumer.pollOnce()).toEqual(["processed"]);
      const refund = await submit(
        api,
        wagerBody(wallet, { kind: "REFUND", referenceExternalTransactionId: newExternalId("ausente") }),
      );
      pendings.push(refund.body.transactionId);
      await runWorkerUntil(worker, async () => (await pendingRow(refund.body.transactionId)).attempts >= 1);

      const after = {
        httpOk: await histogram("wagering_processing_duration_seconds", { channel: "http", outcome: "ok" }),
        httpError: await histogram("wagering_processing_duration_seconds", { channel: "http", outcome: "error" }),
        sqs: await histogram("wagering_processing_duration_seconds", { channel: "sqs", outcome: "ok" }),
        worker: await histogram("wagering_processing_duration_seconds", { channel: "worker", outcome: "ok" }),
      };
      expect(after.httpOk.count).toBe(before.httpOk.count + 2);
      expect(after.httpError.count).toBe(before.httpError.count + 1);
      expect(after.sqs.count).toBe(before.sqs.count + 1);
      expect(after.worker.count).toBeGreaterThanOrEqual(before.worker.count + 1);
    },
    SLOW_TEST_MS,
  );
});

describe("D1.7 D22.8: refund_after_settlement", () => {
  async function settledBet(wallet: TestWallet): Promise<string> {
    const betId = newExternalId("bet");
    expect((await submit(api, wagerBody(wallet, { externalTransactionId: betId, money: brl("10.00") }))).status).toBe(200);
    const win = await submit(
      api,
      wagerBody(wallet, { kind: "WIN", referenceExternalTransactionId: betId, money: brl("3.00") }),
    );
    expect(win.status).toBe(200);
    return betId;
  }

  it("D1.7 D22.8: REFUND de BET liquidada → 200 PROCESSED, contador +1 e log warn só com ids", async () => {
    const wallet = await createWallet(api, brl("100.00"));
    const betId = await settledBet(wallet);
    const before = await metricValue("wagering_refund_after_settlement_total", { channel: "http" });
    const from = api.logs.length;

    const refund = await submit(
      api,
      wagerBody(wallet, { kind: "REFUND", referenceExternalTransactionId: betId, money: brl("10.00") }),
    );

    expect(refund.status).toBe(200);
    expect(refund.body.status).toBe("PROCESSED");
    expect(await metricValue("wagering_refund_after_settlement_total", { channel: "http" })).toBe(before + 1);
    const line = api.logs.slice(from).find((entry) => entry.msg === "refund_after_settlement");
    expect(line).toMatchObject({ level: 40, transactionId: refund.body.transactionId, walletId: wallet.id });
    expect(typeof line?.referenceTransactionId).toBe("string");
    expect(JSON.stringify(line)).not.toContain("10.00");
    expect(JSON.stringify(line)).not.toContain(wallet.playerId);
  });

  it("D1.7 D22.8: REFUND de BET não liquidada → contador inalterado", async () => {
    const wallet = await createWallet(api, brl("100.00"));
    const betId = newExternalId("bet");
    await submit(api, wagerBody(wallet, { externalTransactionId: betId, money: brl("10.00") }));
    const before = await metricValue("wagering_refund_after_settlement_total", { channel: "http" });

    const refund = await submit(
      api,
      wagerBody(wallet, { kind: "REFUND", referenceExternalTransactionId: betId, money: brl("10.00") }),
    );

    expect(refund.status).toBe(200);
    expect(await metricValue("wagering_refund_after_settlement_total", { channel: "http" })).toBe(before);
  });

  it(
    "D1.7 D22.8: REFUND pendente resolvido pelo worker depois do WIN → conta com channel=worker",
    async () => {
      const worker = await startTestWorker();
      closers.push(() => worker.close());
      const wallet = await createWallet(api, brl("100.00"));
      const betId = newExternalId("bet");
      const refund = await submit(
        api,
        wagerBody(wallet, { kind: "REFUND", referenceExternalTransactionId: betId, money: brl("10.00") }),
      );
      expect(refund.status).toBe(202);
      pendings.push(refund.body.transactionId);
      await submit(api, wagerBody(wallet, { externalTransactionId: betId, money: brl("10.00") }));
      await submit(api, wagerBody(wallet, { kind: "WIN", referenceExternalTransactionId: betId, money: brl("3.00") }));
      const before = await metricValue("wagering_refund_after_settlement_total", { channel: "worker" });

      await runWorkerUntil(worker, async () => (await pendingRow(refund.body.transactionId)).status === "PROCESSED");

      expect(await metricValue("wagering_refund_after_settlement_total", { channel: "worker" })).toBe(before + 1);
    },
    SLOW_TEST_MS,
  );
});

describe("D22.11: valores de label observados", () => {
  it("D22.11: depois de todas as situações, todo valor de label observado pertence ao conjunto fechado", async () => {
    const closed = METRIC_LABEL_VALUES as Record<string, readonly string[]>;
    const outside: string[] = [];

    for (const [label, values] of await observedLabelValues()) {
      if (label === "le") continue;
      for (const value of values) {
        if (!closed[label]?.includes(value)) outside.push(`${label}=${value}`);
      }
    }

    expect(outside).toEqual([]);
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { ChangeMessageVisibilityCommand, DeleteMessageCommand } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { UnitOfWork } from "../../../src/modules/wagering/application/ports";
import { SqsWagerQueue, type SqsSender } from "../../../src/modules/wagering/infra/messaging/sqs-wager-queue";
import { trackDlqDepth, trackOutboxBacklog } from "../../../src/modules/wagering/infra/observability/gauges";
import { WAGERING_ENTITIES } from "../../../src/modules/wagering/infra/persistence";
import { MikroOrmOutboxStore } from "../../../src/modules/wagering/infra/persistence/outbox-store";
import { createSqsClient } from "../../../src/shared/aws/sqs-client";
import { ConflictError, TransientError } from "../../../src/shared/errors/app-errors";
import { createLogger, logger } from "../../../src/shared/logger/logger";
import { createOrm } from "../../../src/shared/orm/create-orm";
import { startTestApi, type TestApi } from "../../support/api";
import { envelopeJson, startTestAuditor } from "../../support/auditor";
import { startTestConsumer, type TestConsumer, wagerMessage } from "../../support/consumer";
import { connect, credentialsFor, newId, withClient } from "../../support/db";
import { expectLedgerMatchesBalances } from "../../support/db-ledger-invariant";
import { insertRow, rejected, transactionRow } from "../../support/db-seed";
import { startHoldingProxy } from "../../support/holding-proxy";
import { closedSetViolations, histogram, metricValue } from "../../support/metrics";
import { createTestTopic, insertOutboxEvent, parkAllOutbox, startTestPublisher } from "../../support/outbox";
import { waitForWaiterOn } from "../../support/pg-locks";
import { createTestQueues, queueCounts, sendMessage, type TestQueues, testSqsClient } from "../../support/sqs";
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

/** Unidade de trabalho em que toda chamada lança `error()`. */
function failingWith(error: () => Error): (uow: UnitOfWork) => UnitOfWork {
  return () => ({ run: () => Promise.reject(error()) });
}

/** Cliente SQS cujo comando `failing` falha; os outros vão ao LocalStack real. */
function failingSqs(failing: typeof DeleteMessageCommand | typeof ChangeMessageVisibilityCommand) {
  return (client: SqsSender): SqsSender => ({
    send(command, options) {
      if (command instanceof failing) {
        return Promise.reject(Object.assign(new Error(`${failing.name} falhou (teste)`), { code: "ECONNRESET" }));
      }
      return client.send(command, options);
    },
  });
}

/** Um `ConflictError` com um code que nenhuma lista conhece (D22.4, D22.11). */
class UnknownCodeConflict extends ConflictError {
  constructor() {
    super("CODIGO_NOVO_S9", "conflito com um code novo, injetado pelo teste");
  }
}

/** `lock_timeout` da conexão da app (D5), em segundos. */
const LOCK_TIMEOUT_S = 2;

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

  it(
    "R-12-03 D22.3: transitório no auditor → retry de event_auditor",
    async () => {
      const target = await queues();
      const auditor = await startTestAuditor(target, { wrapUow: failingOnce() });
      closers.push(() => auditor.close());
      const before = await metricValue("wagering_retries_total", { component: "event_auditor" });

      await sendMessage(target.queueUrl, envelopeJson({ walletId: newId(), walletVersion: 2 }).body, { groupId: "g-1" });
      expect(await auditor.pollOnce()).toEqual(["retry_scheduled"]);
      expect(await auditor.pollOnce()).toEqual(["processed"]);

      expect(await metricValue("wagering_retries_total", { component: "event_auditor" })).toBe(before + 1);
    },
    SLOW_TEST_MS,
  );

  it(
    "R-12-03 D22.3 D3.6: o UNIQUE barra o commit e o use case repete → retry de submission",
    async () => {
      // Como no teste da S4 (test/concurrency/submit-transaction.spec.ts): uma
      // rival grava a mesma key na wallet B e segura o commit; a submissão na
      // wallet A espera no índice (pg_locks), a rival commita e o UNIQUE barra.
      const walletA = await createWallet(api, brl("100.00"));
      const walletB = await createWallet(api, brl("100.00"));
      const body = wagerBody(walletA, { money: brl("10.00") });
      const key = `provider-a:${body.externalTransactionId}`;
      const before = await metricValue("wagering_retries_total", { component: "submission" });
      const rival = await connect("app");
      const observer = await connect("app");
      try {
        await rival.query("BEGIN");
        await insertRow(
          rival,
          "wager_transactions",
          transactionRow(
            { id: walletB.id, playerId: walletB.playerId, currency: "BRL" },
            {
              ...rejected,
              provider_id: "provider-a",
              idempotency_key: key,
              external_transaction_id: `rival-${newId()}`,
              balance_after: "100.00",
            },
          ),
        );
        const { rows } = await rival.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");

        const pending = submit(api, body, { key });
        await waitForWaiterOn(observer, rows[0]?.pid as number);
        await rival.query("COMMIT");

        expect((await pending).status).toBe(409);
      } finally {
        await rival.query("ROLLBACK");
        await rival.end();
        await observer.end();
      }

      expect(await metricValue("wagering_retries_total", { component: "submission" })).toBe(before + 1);
    },
    SLOW_TEST_MS,
  );

  it(
    "R-12-03 D22.3: o ChangeMessageVisibility do backoff falha → nada foi agendado, o retry não conta",
    async () => {
      const target = await queues();
      const consumer = await consumerOn(target, {
        wrapUow: failingOnce(),
        wrapSqs: failingSqs(ChangeMessageVisibilityCommand),
      });
      const wallet = await createWallet(api, brl("100.00"));
      const before = await metricValue("wagering_retries_total", { component: "consumer" });

      await sendMessage(target.queueUrl, wagerMessage(wallet).body, { groupId: wallet.id });
      expect(await consumer.pollOnce()).toEqual(["unresolved"]);

      expect(await metricValue("wagering_retries_total", { component: "consumer" })).toBe(before);
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

  it(
    "R-12-03 D22.4 D8.3: transitório até o limite de tentativas → DLQ{wager_transactions, ATTEMPTS_EXHAUSTED}",
    async () => {
      const target = await queues();
      const consumer = await consumerOn(target, {
        wrapUow: failingWith(() => new TestTransientError()),
        policy: { maxAttempts: 2 },
      });
      const wallet = await createWallet(api, brl("100.00"));
      const labels = { consumer: "wager_transactions", reason: "ATTEMPTS_EXHAUSTED" };
      const before = await metricValue("wagering_dlq_messages_total", labels);

      await sendMessage(target.queueUrl, wagerMessage(wallet).body, { groupId: wallet.id });
      expect(await consumer.pollOnce()).toEqual(["retry_scheduled"]);
      expect(await consumer.pollOnce()).toEqual(["dead_lettered"]);

      expect(await metricValue("wagering_dlq_messages_total", labels)).toBe(before + 1);
      expect((await queueCounts(target.dlqUrl)).visible).toBe(1);
    },
    SLOW_TEST_MS,
  );

  it(
    "R-12-03 D22.4: a cópia chega à DLQ e o delete falha (DeadLetterDeleteError) → conta mesmo assim",
    async () => {
      const target = await queues();
      const consumer = await consumerOn(target, { wrapSqs: failingSqs(DeleteMessageCommand) });
      const labels = { consumer: "wager_transactions", reason: "VALIDATION_ERROR" };
      const before = await metricValue("wagering_dlq_messages_total", labels);

      await sendMessage(target.queueUrl, "{ isto não é json", { groupId: "g-1" });
      expect(await consumer.pollOnce()).toEqual(["dead_letter_not_deleted"]);

      expect(await metricValue("wagering_dlq_messages_total", labels)).toBe(before + 1);
      // A cópia está mesmo na DLQ (cliente direto, sem o wrapper).
      expect((await queueCounts(target.dlqUrl)).visible).toBe(1);
    },
    SLOW_TEST_MS,
  );

  it(
    "D22.4 D22.11: um code que nenhuma lista conhece → DLQ com reason=OTHER, nunca o texto do code",
    async () => {
      const target = await queues();
      const consumer = await consumerOn(target, { wrapUow: failingWith(() => new UnknownCodeConflict()) });
      const wallet = await createWallet(api, brl("100.00"));
      const before = await metricValue("wagering_dlq_messages_total", { consumer: "wager_transactions", reason: "OTHER" });

      await sendMessage(target.queueUrl, wagerMessage(wallet).body, { groupId: wallet.id });
      expect(await consumer.pollOnce()).toEqual(["dead_lettered"]);

      expect(
        await metricValue("wagering_dlq_messages_total", { consumer: "wager_transactions", reason: "OTHER" }),
      ).toBe(before + 1);
      expect(
        await metricValue("wagering_dlq_messages_total", { consumer: "wager_transactions", reason: "CODIGO_NOVO_S9" }),
      ).toBe(0);
    },
    SLOW_TEST_MS,
  );

  it(
    "D22.4: a leitura da profundidade estoura o prazo → o gauge fica com o último valor e loga warn",
    async () => {
      const target = await queues();
      // A DLQ não deduplica por conteúdo: cada envio direto leva o próprio id.
      const toDlq = () =>
        sendMessage(target.dlqUrl, JSON.stringify({ probe: newId() }), { groupId: "g-dlq", deduplicationId: newId() });
      await toDlq();
      // O SQS real atrás de um proxy que o teste segura (sem simular nada).
      const proxy = await startHoldingProxy(process.env.AWS_ENDPOINT ?? "");
      const sqs = createSqsClient({ region: process.env.AWS_REGION ?? "us-east-1", endpoint: proxy.url });
      const lines: Record<string, unknown>[] = [];
      const captured = createLogger({ write: (line: string) => lines.push(JSON.parse(line)) });
      const stopTracking = trackDlqDepth("wager_transactions_dlq", new SqsWagerQueue(sqs, target), captured, 300);
      closers.push(async () => {
        stopTracking();
        proxy.release();
        sqs.destroy();
        await proxy.close();
      });

      expect(await metricValue("sqs_dlq_depth", { queue: "wager_transactions_dlq" })).toBe(1);

      proxy.hold();
      // A profundidade real muda para 2 (cliente direto); o gauge não pode vê-la.
      await toDlq();
      expect((await queueCounts(target.dlqUrl)).visible).toBe(2);

      expect(await metricValue("sqs_dlq_depth", { queue: "wager_transactions_dlq" })).toBe(1);
      expect(lines).toContainEqual(
        expect.objectContaining({
          level: 40,
          gauge: "sqs_dlq_depth:wager_transactions_dlq",
          msg: "leitura do gauge falhou; fica o último valor",
        }),
      );
    },
    SLOW_TEST_MS,
  );
});

describe("R-12-03 D22.5: conflitos de lock e tempo de espera", () => {
  it(
    "R-12-03 D22.5: a espera pelo lock da wallet entra no histograma com outcome=acquired",
    async () => {
      const wallet = await createWallet(api, brl("100.00"));
      const before = await histogram("wallet_lock_wait_seconds", { outcome: "acquired" });
      const lock = await holdWalletLock(wallet.id);
      const observer = await connect("app");
      let heldMs = 0;
      try {
        const submission = submit(api, wagerBody(wallet));
        await waitForWalletLockWaiters(observer, lock, 1);
        const seenAt = performance.now();
        // Medido até **antes** de mandar o ROLLBACK: o lock sai no servidor
        // quando ele chega lá. Depois disso, a volta da resposta e o
        // `holder.end()` não têm ordem garantida com o fim da espera do
        // `lockById` (CI #3: espera de 3 ms × 16 ms medidos até o fim do release).
        const releaseStartedAt = performance.now();
        heldMs = releaseStartedAt - seenAt;
        await lock.release();
        expect((await submission).status).toBe(200);
      } finally {
        await lock.release();
        await observer.end();
      }

      const after = await histogram("wallet_lock_wait_seconds", { outcome: "acquired" });
      expect(after.count).toBeGreaterThanOrEqual(before.count + 1);
      // A espera durou, no mínimo, do waiter visto no pg_locks até o lock ser solto.
      expect(after.sum - before.sum).toBeGreaterThanOrEqual(heldMs / 1000 - 0.001);
    },
    SLOW_TEST_MS,
  );

  it(
    "R-12-03 D22.5 D5: lock_timeout → 503, wallet_lock_conflicts_total{lock_timeout} e a espera inteira no histograma com outcome=lock_timeout",
    async () => {
      const wallet = await createWallet(api, brl("100.00"));
      const before = {
        conflicts: await metricValue("wallet_lock_conflicts_total", { reason: "lock_timeout" }),
        wait: await histogram("wallet_lock_wait_seconds", { outcome: "lock_timeout" }),
      };
      const lock = await holdWalletLock(wallet.id);
      try {
        const response = await submit(api, wagerBody(wallet));
        expect(response.status).toBe(503);
      } finally {
        await lock.release();
      }

      expect(await metricValue("wallet_lock_conflicts_total", { reason: "lock_timeout" })).toBe(before.conflicts + 1);
      const after = await histogram("wallet_lock_wait_seconds", { outcome: "lock_timeout" });
      expect(after.count).toBe(before.wait.count + 1);
      // A espera foi até o lock_timeout (2 s): é a pior espera da hot wallet, e agora ela aparece.
      expect(after.sum - before.wait.sum).toBeGreaterThanOrEqual(LOCK_TIMEOUT_S - 0.05);
    },
    SLOW_TEST_MS,
  );

  it(
    "R-12-03 D22.5: deadlock real no lock da wallet → wallet_lock_conflicts_total{deadlock} e outcome=deadlock no histograma",
    async () => {
      // O ciclo, sem sleep: o consumidor grava a inbox (1º lock, D19.4) e
      // espera a wallet, que a sessão `holder` travou (visto no pg_locks); o
      // holder então tenta gravar a mesma chave da inbox e passa a esperar o
      // consumidor. O consumidor esperava antes: o deadlock_timeout dele vence
      // primeiro e ele é a vítima (40P01, transitório → retry).
      const target = await queues();
      const consumer = await consumerOn(target);
      const wallet = await createWallet(api, brl("100.00"));
      const message = wagerMessage(wallet);
      const before = {
        conflicts: await metricValue("wallet_lock_conflicts_total", { reason: "deadlock" }),
        wait: await histogram("wallet_lock_wait_seconds", { outcome: "deadlock" }),
      };
      const holder = await connect("app");
      const observer = await connect("app");
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM wallets WHERE id = $1 FOR UPDATE", [wallet.id]);
        const { rows } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        await sendMessage(target.queueUrl, message.body, { groupId: wallet.id });

        const polled = consumer.pollOnce();
        await waitForWalletLockWaiters(observer, { pid: rows[0]?.pid as number, walletId: wallet.id }, 1);
        const holderInsert = holder
          .query(
            `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
             VALUES ($1, $2, $3, now(), now())`,
            [consumer.consumerName, message.messageId, "0".repeat(64)],
          )
          .then(
            () => "inserido",
            (error: { code?: string }) => `falhou: ${error.code}`,
          );

        expect(await polled).toEqual(["retry_scheduled"]);
        // A vítima foi o consumidor: o holder seguiu e gravou a chave.
        expect(await holderInsert).toBe("inserido");
      } finally {
        await holder.query("ROLLBACK");
        await holder.end();
        await observer.end();
      }

      expect(await metricValue("wallet_lock_conflicts_total", { reason: "deadlock" })).toBe(before.conflicts + 1);
      expect((await histogram("wallet_lock_wait_seconds", { outcome: "deadlock" })).count).toBe(before.wait.count + 1);
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
  it("D22.11: depois de todas as situações, todo valor de label observado pertence à lista da própria métrica", async () => {
    expect(await closedSetViolations()).toEqual([]);
  });
});

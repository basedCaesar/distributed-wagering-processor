import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { startTestIssuer, type TestIssuer } from "../../support/auth";
import { wagerMessage } from "../../support/consumer";
import { expectLedgerMatchesBalances } from "../../support/db-ledger-invariant";
import { createTestTopic, type TestTopic } from "../../support/outbox";
import { apiClient, authEnv, ProcessGroup, type ProcessKind, type TestProcess, waitFor } from "../../support/processes";
import { createTestQueues, sendMessage, type TestQueues } from "../../support/sqs";
import { type ApiClient, brl, createWallet, newExternalId, submit, wagerBody } from "../../support/wagering";
import { pendingRow } from "../../support/worker";

/**
 * D11.2 D22.1: `/metrics` numa porta interna própria, sem auth, nos 5
 * processos da D7.4 (entrypoints reais). A porta pública da `api` não o
 * serve. Também prova a montagem de produção: cada processo conta no seu
 * próprio registry o que ele fez.
 */

/** Subir os 5 processos: o padrão de 5 s do bun não cabe. */
const SLOW_TEST_MS = 90_000;

/** As métricas da D11.2 (D22.1–22.8), as mesmas em todo processo: o registry é um só módulo. */
const D11_2_METRICS = [
  "wagering_transactions_total",
  "wagering_duplicates_total",
  "wagering_retries_total",
  "wagering_dlq_messages_total",
  "sqs_dlq_depth",
  "wallet_lock_wait_seconds",
  "wallet_lock_conflicts_total",
  "outbox_pending_events",
  "outbox_lag_seconds",
  "wagering_processing_duration_seconds",
  "reconciliation_divergences_total",
  "wagering_refund_after_settlement_total",
];

let issuer: TestIssuer;
let txQueues: TestQueues;
let auditorQueues: TestQueues;
let topic: TestTopic;
let group: ProcessGroup;
const processes = new Map<ProcessKind, TestProcess>();
let client: ApiClient;

async function scrape(process: TestProcess): Promise<Response> {
  return fetch(`${process.metricsUrl}/metrics`);
}

/** Valor de uma série no formato texto do Prometheus, ou `undefined` se ela não existe. */
function sample(text: string, name: string, labels: Record<string, string>): number | undefined {
  for (const line of text.split("\n")) {
    if (!line.startsWith(`${name}{`) && !line.startsWith(`${name} `)) continue;
    const labelText = line.slice(name.length, line.lastIndexOf(" "));
    if (Object.entries(labels).every(([key, value]) => labelText.includes(`${key}="${value}"`))) {
      return Number(line.slice(line.lastIndexOf(" ") + 1));
    }
  }
  return undefined;
}

function get(kind: ProcessKind): TestProcess {
  const process = processes.get(kind);
  if (!process) throw new Error(`${kind} não subiu`);
  return process;
}

beforeAll(async () => {
  issuer = await startTestIssuer();
  txQueues = await createTestQueues();
  auditorQueues = await createTestQueues();
  topic = await createTestTopic();
  group = new ProcessGroup("s9-metrics-endpoint");
  const spawned = await Promise.all([
    group.spawn("api", { instance: "api-metrics", env: authEnv(issuer) }),
    group.spawn("consumer", {
      instance: "consumer-metrics",
      env: { QUEUE_WAGER_TRANSACTIONS: txQueues.queueName, QUEUE_WAGER_TRANSACTIONS_DLQ: txQueues.dlqName },
    }),
    group.spawn("pending-worker", { instance: "worker-metrics" }),
    group.spawn("outbox-publisher", {
      instance: "publisher-metrics",
      env: { SNS_TOPIC_WAGERING_EVENTS: topic.topicName },
    }),
    group.spawn("event-auditor", {
      instance: "auditor-metrics",
      env: {
        QUEUE_WAGERING_EVENTS_AUDITOR: auditorQueues.queueName,
        QUEUE_WAGERING_EVENTS_AUDITOR_DLQ: auditorQueues.dlqName,
      },
    }),
  ]);
  for (const process of spawned) processes.set(process.kind, process);
  client = apiClient(get("api"), issuer);
}, SLOW_TEST_MS);

afterAll(async () => {
  await group.close();
  await txQueues.destroy();
  await auditorQueues.destroy();
  await topic.destroy();
  await issuer.stop();
  await expectLedgerMatchesBalances();
});

describe("D11.2 D22.1: /metrics em cada processo", () => {
  for (const kind of ["api", "consumer", "pending-worker", "outbox-publisher", "event-auditor"] as const) {
    it(`D11.2 D22.1: ${kind} serve /metrics na METRICS_PORT, sem token, com as métricas da D11.2`, async () => {
      const response = await scrape(get(kind));

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/plain");
      const text = await response.text();
      for (const name of D11_2_METRICS) {
        expect({ name, present: text.includes(`# TYPE ${name} `) }).toEqual({ name, present: true });
      }
    });
  }

  it("D22.1: a porta pública da api não serve /metrics (404)", async () => {
    const response = await client.request("GET", "/metrics");

    expect(response.status).toBe(404);
  });

  it("D22.1: a porta de métricas só serve /metrics (404 no resto)", async () => {
    const response = await fetch(`${get("consumer").metricsUrl}/wallets`);

    expect(response.status).toBe(404);
  });
});

describe("D22.2 D22.4 D22.6: a montagem de produção conta no processo certo", () => {
  it(
    "D22.2: submissão HTTP → a api conta channel=http; mensagem → o consumer conta channel=sqs",
    async () => {
      const wallet = await createWallet(client, brl("100.00"));
      expect((await submit(client, wagerBody(wallet))).status).toBe(200);
      const message = wagerMessage(wallet);
      await sendMessage(txQueues.queueUrl, message.body, { groupId: wallet.id });
      await waitFor(
        () => get("consumer").lines.some((line) => line.includes("mensagem processada") && line.includes(message.messageId)),
        "consumer processou a mensagem",
      );

      const apiText = await (await scrape(get("api"))).text();
      const consumerText = await (await scrape(get("consumer"))).text();
      expect(sample(apiText, "wagering_transactions_total", { status: "PROCESSED", kind: "BET", channel: "http" })).toBeGreaterThanOrEqual(1);
      expect(sample(consumerText, "wagering_transactions_total", { status: "PROCESSED", kind: "BET", channel: "sqs" })).toBeGreaterThanOrEqual(1);
      expect(sample(apiText, "wagering_processing_duration_seconds_count", { channel: "http", outcome: "ok" })).toBeGreaterThanOrEqual(1);
    },
    SLOW_TEST_MS,
  );

  it(
    "D22.2: pendente resolvida → o pending-worker conta channel=worker",
    async () => {
      const wallet = await createWallet(client, brl("100.00"));
      const betId = newExternalId("bet");
      const refund = await submit(client, wagerBody(wallet, { kind: "REFUND", referenceExternalTransactionId: betId }));
      expect(refund.status).toBe(202);
      expect((await submit(client, wagerBody(wallet, { externalTransactionId: betId }))).status).toBe(200);
      await waitFor(
        async () => (await pendingRow(refund.body.transactionId)).status === "PROCESSED",
        "worker resolveu a pendente",
      );

      const text = await (await scrape(get("pending-worker"))).text();
      expect(sample(text, "wagering_transactions_total", { status: "PROCESSED", kind: "REFUND", channel: "worker" })).toBeGreaterThanOrEqual(1);
    },
    SLOW_TEST_MS,
  );

  it("D22.4: consumer e auditor publicam a profundidade da própria DLQ", async () => {
    const consumerText = await (await scrape(get("consumer"))).text();
    const auditorText = await (await scrape(get("event-auditor"))).text();

    expect(sample(consumerText, "sqs_dlq_depth", { queue: "wager_transactions_dlq" })).toBe(0);
    expect(sample(auditorText, "sqs_dlq_depth", { queue: "event_auditor_dlq" })).toBe(0);
  });

  it("D22.6: o outbox-publisher publica pendentes e lag", async () => {
    const text = await (await scrape(get("outbox-publisher"))).text();

    expect(sample(text, "outbox_pending_events", {})).toBeGreaterThanOrEqual(0);
    expect(sample(text, "outbox_lag_seconds", {})).toBeGreaterThanOrEqual(0);
  });

  it("D22.11: nenhum id aparece como valor de label no texto de nenhum processo", async () => {
    for (const process of processes.values()) {
      const text = await (await scrape(process)).text();
      // Ids da D6.6 são UUIDv7: nenhum pode estar entre aspas num label.
      expect(text).not.toMatch(/="[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    }
  });
});

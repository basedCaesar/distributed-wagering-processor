import { sleep } from "k6";
import exec from "k6/execution";
import http from "k6/http";
import { Counter, Trend } from "k6/metrics";
import { LOAD_PLAN } from "../lib/plan.ts";
import { env, loadWallets, SUMMARY_TREND_STATS, sampleOutbox, waitOutboxDrain, walletAt, writeSummary } from "./common.ts";

/**
 * Passo D do `test:load` (D26.2, D26.9): as mensagens do §10 (sem atributos,
 * só `MessageGroupId` = walletId, D8.1) por `SendMessageBatch` direto na API
 * HTTP (protocolo JSON) do SQS do LocalStack. É um atalho que só existe no
 * LocalStack: ele não confere a assinatura, então o `Authorization` é fixo.
 * Depois do envio, o teardown espera a fila esvaziar (todo ack sai depois do
 * commit, D8) e a outbox.
 */

const PREFIX = env("LOAD_PREFIX");
const SQS = env("LOAD_SQS");
const QUEUE_URL = env("LOAD_QUEUE_URL");
const WALLETS = loadWallets();
const { messages, batchSize, betAmount } = LOAD_PLAN.queue;

const ops = new Counter("ops");
const unexpected = new Counter("unexpected");
const sendDuration = new Trend("req_duration", true);
const queueDrainSeconds = new Trend("queue_drain_seconds");
const queueDrainTimeout = new Counter("queue_drain_timeout");

export const options = {
  scenarios: {
    main: {
      executor: "shared-iterations",
      exec: "send",
      vus: 10,
      iterations: messages / batchSize,
      maxDuration: "120s",
    },
  },
  summaryTrendStats: SUMMARY_TREND_STATS,
  // Espera a fila e depois a outbox, cada uma com o teto da D26.4.
  teardownTimeout: `${2 * LOAD_PLAN.drainTimeoutS + 30}s`,
};

function sqs(action: string, payload: unknown) {
  return http.post(SQS, JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/x-amz-json-1.0",
      "X-Amz-Target": `AmazonSQS.${action}`,
      Authorization:
        "AWS4-HMAC-SHA256 Credential=test/20260101/us-east-1/sqs/aws4_request, SignedHeaders=host, Signature=0",
    },
    tags: { name: action },
    timeout: "20s",
  });
}

export function setup(): { start: number } {
  return { start: Date.now() };
}

export function send(): void {
  const batch = exec.scenario.iterationInTest;
  const entries = [];
  for (let k = 0; k < batchSize; k++) {
    const m = batch * batchSize + k;
    const wallet = walletAt(WALLETS, m);
    const externalTransactionId = `${PREFIX}-${m}`;
    entries.push({
      Id: String(k),
      MessageGroupId: wallet.walletId,
      MessageBody: JSON.stringify({
        messageId: `${PREFIX}-${m}`,
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data: {
          providerId: "provider-a",
          externalTransactionId,
          idempotencyKey: `provider-a:${externalTransactionId}`,
          playerId: wallet.playerId,
          walletId: wallet.walletId,
          roundId: `${PREFIX}-round-${m}`,
          gameId: "load-test",
          kind: "BET",
          money: { amount: betAmount, currency: "BRL" },
        },
      }),
    });
  }
  const res = sqs("SendMessageBatch", { QueueUrl: QUEUE_URL, Entries: entries });
  sendDuration.add(res.timings.duration);
  ops.add(batchSize);
  const failed = res.status === 200 ? ((res.json("Failed") as unknown[] | null) ?? []).length : batchSize;
  if (failed > 0) {
    unexpected.add(failed);
    console.log(`UNEXPECTED SendMessageBatch status=${res.status} failed=${failed}`);
  }
}

function queueDepth(): number | undefined {
  const res = sqs("GetQueueAttributes", {
    QueueUrl: QUEUE_URL,
    AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
  });
  if (res.status !== 200) return undefined;
  const attrs = res.json("Attributes") as Record<string, string> | null;
  if (attrs === null) return undefined;
  return Number(attrs.ApproximateNumberOfMessages ?? "0") + Number(attrs.ApproximateNumberOfMessagesNotVisible ?? "0");
}

export function teardown(data: { start: number }): void {
  const deadline = Date.now() + LOAD_PLAN.drainTimeoutS * 1000;
  let drained = false;
  while (Date.now() < deadline) {
    sampleOutbox();
    if (queueDepth() === 0) {
      drained = true;
      break;
    }
    sleep(1);
  }
  if (drained) queueDrainSeconds.add((Date.now() - data.start) / 1000);
  else queueDrainTimeout.add(1);
  waitOutboxDrain();
}

export const handleSummary = writeSummary;

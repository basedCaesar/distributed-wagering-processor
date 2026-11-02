import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { type QueueMessage, SqsWagerQueue } from "../../../src/modules/wagering/infra/messaging/sqs-wager-queue";
import { createSqsClient, RECEIVE_TIMEOUT_MARGIN_MS } from "../../../src/shared/aws/sqs-client";
import { type HoldingProxy, startHoldingProxy } from "../../support/holding-proxy";
import { createTestQueues, queueCounts, sendMessage, type TestQueues } from "../../support/sqs";

/** Timeout curto dos comandos no teste; o do receive é o long poll + margem. */
const COMMAND_TIMEOUT_MS = 1000;
/** Folga para o relógio e para as tentativas do SDK (cada uma com o mesmo timeout). */
const SLACK_MS = 1500;

let proxy: HoldingProxy;
let queues: TestQueues;
let client: SQSClient;
let queue: SqsWagerQueue;

beforeEach(async () => {
  proxy = await startHoldingProxy(process.env.AWS_ENDPOINT ?? "");
  queues = await createTestQueues();
  client = createSqsClient(
    { region: process.env.AWS_REGION ?? "us-east-1", endpoint: proxy.url },
    { commandTimeoutMs: COMMAND_TIMEOUT_MS },
  );
  queue = new SqsWagerQueue(client, { queueUrl: queues.queueUrl, dlqUrl: queues.dlqUrl });
});

afterEach(async () => {
  proxy.release();
  client.destroy();
  await proxy.close();
  await queues.destroy();
});

/** Uma mensagem real da fila, recebida pelo proxy antes de segurar (conexão keep-alive aberta). */
async function receiveOne(): Promise<QueueMessage> {
  await sendMessage(queues.queueUrl, JSON.stringify({ probe: Bun.randomUUIDv7() }), { groupId: "sqs-timeout" });
  const [message] = await queue.receive({ maxMessages: 1, waitTimeSeconds: 2, visibilityTimeoutSeconds: 60 });
  if (!message) throw new Error("a mensagem do teste não chegou");
  return message;
}

/** Nome do erro e tempo decorrido; `respondeu` se o SQS respondeu. */
async function timed(call: () => Promise<unknown>): Promise<{ outcome: string; elapsed: number }> {
  const started = performance.now();
  const outcome = await call().then(
    () => "respondeu",
    (error: unknown) => (error instanceof Error ? error.name : "erro"),
  );
  return { outcome, elapsed: performance.now() - started };
}

describe("D19.6 D19.9 D21.12: o timeout do cliente SQS vale de verdade", () => {
  it("D21.12 R-10-05: SQS que aceita a conexão e não responde → ack (DeleteMessage), ChangeMessageVisibility e a cópia para a DLQ (SendMessage) falham no timeout do comando, sem prender o consumidor", async () => {
    const message = await receiveOne();
    proxy.hold();

    const results = {
      ack: await timed(() => queue.ack(message)),
      changeVisibility: await timed(() => queue.changeVisibility(message, 0)),
      deadLetter: await timed(() => queue.deadLetter(message)),
    };

    for (const [command, { outcome, elapsed }] of Object.entries(results)) {
      expect({ command, outcome }).toEqual({ command, outcome: "TimeoutError" });
      // Uma tentativa por comando (o consumidor é quem repete): no prazo do comando.
      expect({ command, inTime: elapsed < COMMAND_TIMEOUT_MS + SLACK_MS }).toEqual({ command, inTime: true });
    }
    // Com o proxy ainda segurando (o release repassaria os bytes): nada chegou
    // ao SQS, a mensagem continua em voo e a DLQ está vazia. `queueCounts` usa
    // um cliente direto, sem o proxy.
    expect((await queueCounts(queues.dlqUrl)).visible).toBe(0);
    expect((await queueCounts(queues.queueUrl)).inFlight).toBe(1);
  }, 20_000);

  it("D19.9 D21.12: o long poll do ReceiveMessage não é cortado pelo timeout curto dos comandos (fila vazia por 3 s → volta vazio, sem erro)", async () => {
    const { outcome, elapsed } = await timed(() =>
      queue.receive({ maxMessages: 1, waitTimeSeconds: 3, visibilityTimeoutSeconds: 60 }),
    );
    expect(outcome).toBe("respondeu");
    // Esperou o long poll inteiro, muito além do timeout de 1 s dos comandos.
    expect(elapsed).toBeGreaterThan(2500);
  }, 20_000);

  it("D19.9 D21.12: ReceiveMessage com SQS que não responde → TimeoutError no long poll + margem", async () => {
    await receiveOne();
    proxy.hold();
    const { outcome, elapsed } = await timed(() =>
      queue.receive({ maxMessages: 1, waitTimeSeconds: 1, visibilityTimeoutSeconds: 60 }),
    );
    expect(outcome).toBe("TimeoutError");
    expect(elapsed).toBeGreaterThan(1000 + RECEIVE_TIMEOUT_MARGIN_MS - 500);
    expect(elapsed).toBeLessThan(1000 + RECEIVE_TIMEOUT_MARGIN_MS + SLACK_MS);
  }, 30_000);
});

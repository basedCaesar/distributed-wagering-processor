import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { CreateQueueCommand, DeleteQueueCommand, ReceiveMessageCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import pino from "pino";
import { type RealtimeConnection, RealtimeHub } from "../../../src/modules/realtime/application/realtime-hub";
import type { RealtimeEvent } from "../../../src/modules/realtime/domain/realtime-event";
import { RealtimeEventLoop } from "../../../src/modules/realtime/infra/messaging/realtime-event-loop";
import { createSqsClient } from "../../../src/shared/aws/sqs-client";
import { startTestIssuer, type TestIssuer } from "../../support/auth";
import { metricValue } from "../../support/metrics";
import { createTestTopic, type TestTopic } from "../../support/outbox";
import { ProcessGroup, waitFor } from "../../support/processes";
import {
  balanceChangedEnvelope,
  deleteInstanceQueue,
  instanceQueueUrl,
  instanceSubscriptions,
  newInstanceId,
  publishEnvelope,
  spawnRealtime,
  startTestRealtime,
} from "../../support/realtime";
import { queueCounts } from "../../support/sqs";
import { followingClient } from "../../support/ws-client";

const SLOW_TEST_MS = 90_000;
/** Visibilidade da fila da instância (30 s, D28.5) com folga: o pior caso do receive órfão. */
const REDELIVERY_MS = 40_000;
const aws = { region: process.env.AWS_REGION ?? "us-east-1", endpoint: process.env.AWS_ENDPOINT ?? "http://localhost:4567" };
const sqs = createSqsClient(aws, { commandTimeoutMs: 30_000 });
const silent = pino({ level: "silent" });

let topic: TestTopic;
let issuer: TestIssuer;
const instances: string[] = [];

beforeEach(async () => {
  topic = await createTestTopic();
  issuer = await startTestIssuer();
});

afterEach(async () => {
  for (const id of instances.splice(0)) await deleteInstanceQueue(id);
  await issuer.stop();
  await topic.destroy();
});

/** O `SentTimestamp` (ms) da 1ª mensagem visível, sem consumi-la (visibilidade 0). */
async function peekSentTimestamp(queueUrl: string): Promise<number> {
  const { Messages } = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 5,
      VisibilityTimeout: 0,
      MessageSystemAttributeNames: ["SentTimestamp"],
    }),
  );
  const sent = Messages?.[0]?.Attributes?.SentTimestamp;
  if (sent === undefined) throw new Error("mensagem não chegou para o peek");
  return Number.parseInt(sent, 10);
}

describe("D28.5 D28.6: fila por instância, com id estável, da infra", () => {
  it("D28.6: uma mensagem enviada antes da subida não chega ao cliente (delete sem envio); uma enviada depois chega", async () => {
    const walletId = Bun.randomUUIDv7();
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({ QueueName: `realtime-stale-${Bun.randomUUIDv7()}.fifo`, Attributes: { FifoQueue: "true" } }),
    );
    const queueUrl = QueueUrl as string;
    const send = (envelope: ReturnType<typeof balanceChangedEnvelope>) =>
      sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(envelope),
          MessageGroupId: walletId,
          MessageDeduplicationId: envelope.eventId,
        }),
      );
    const received: RealtimeEvent[] = [];
    const follower: RealtimeConnection = { viewer: { roles: new Set(["operator"]) }, deliver: (event) => received.push(event) };
    const hub = new RealtimeHub({
      maxFollowsPerConnection: 50,
      onDeliveryFailure: (error) => {
        throw error;
      },
    });
    hub.follow(follower, walletId);
    const staleBefore = await metricValue("realtime_events_total", { outcome: "stale" });
    const before = balanceChangedEnvelope(walletId, 2);
    const after = balanceChangedEnvelope(walletId, 3);
    let loop: RealtimeEventLoop | undefined;
    try {
      await send(before);
      // A instância "sobe" depois da 1ª mensagem: o início é o horário do SQS dela + 1 ms.
      const startedAt = (await peekSentTimestamp(queueUrl)) + 1;
      await send(after);
      loop = new RealtimeEventLoop({ sqs, queueUrl, hub, logger: silent, startedAt, receiveWaitSeconds: 1 });
      loop.start();

      await waitFor(() => received.length > 0, "a mensagem de depois da subida");
      await waitFor(async () => {
        const counts = await queueCounts(queueUrl);
        return counts.visible + counts.inFlight === 0;
      }, "fila vazia (as duas apagadas)");

      expect(received.map((event) => event.eventId)).toEqual([after.eventId]);
      expect((await metricValue("realtime_events_total", { outcome: "stale" })) - staleBefore).toBe(1);
    } finally {
      await loop?.stop();
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    }
  }, SLOW_TEST_MS);

  it("D28.5: sem a fila da instância, a subida falha com uma mensagem que aponta a infra", async () => {
    const instanceId = newInstanceId();

    const failed = await startTestRealtime({ auth: issuer.config, instanceId }).then(
      () => "subiu",
      (error: Error) => error.message,
    );

    expect(failed).toContain(`wagering-events-realtime-${instanceId}.fifo não existe`);
    expect(failed).toContain("localstack-init.sh");
    expect(await instanceQueueUrl(instanceId)).toBeUndefined();
  }, SLOW_TEST_MS);

  it("D28.5: o stop deixa a fila e a assinatura; a volta reaproveita as duas e recebe pelo tópico", async () => {
    const instanceId = newInstanceId();
    instances.push(instanceId);

    const first = await startTestRealtime({ topicArn: topic.topicArn, auth: issuer.config, instanceId });
    const queueUrl = await instanceQueueUrl(instanceId);
    await first.close();
    expect(await instanceQueueUrl(instanceId)).toBe(queueUrl);
    expect((await instanceSubscriptions(topic.topicArn, instanceId)).length).toBe(1);

    const second = await startTestRealtime({ auth: issuer.config, instanceId });
    try {
      const walletId = Bun.randomUUIDv7();
      const client = await followingClient(second.url, await issuer.operatorToken(), [walletId]);
      const envelope = balanceChangedEnvelope(walletId, 2);
      await publishEnvelope(topic.topicArn, envelope);
      await client.waitFor((message) => message.eventId === envelope.eventId, "evento pela mesma assinatura");
      client.close();
      expect(await instanceQueueUrl(instanceId)).toBe(queueUrl);
    } finally {
      await second.close();
    }
  }, SLOW_TEST_MS);

  it("D28.5 D28.6: kill -9 deixa a fila e a assinatura; a instância volta com as mesmas, sem fila órfã, e descarta o que ficou na fila", async () => {
    const group = new ProcessGroup("realtime-kill");
    try {
      // Long poll de 1 s: o receive que o kill -9 deixa aberto no servidor (D19.9) acaba logo.
      const started = await spawnRealtime(group, { topicArn: topic.topicArn, issuer, env: { REALTIME_RECEIVE_WAIT_S: "1" } });
      instances.push(started.instanceId);
      const queueUrl = (await instanceQueueUrl(started.instanceId)) as string;
      await started.process.kill();
      // Morto sem shutdown: o evento fica na fila. Se o receive órfão o pegou,
      // ele volta a ficar visível quando a visibilidade de 30 s vence.
      const walletId = Bun.randomUUIDv7();
      const whileDown = balanceChangedEnvelope(walletId, 2);
      await publishEnvelope(topic.topicArn, whileDown);
      await waitFor(async () => (await queueCounts(queueUrl)).visible === 1, "evento visível na fila", REDELIVERY_MS);

      await started.process.restart();
      const metrics = `${started.process.metricsUrl}/metrics`;
      await waitFor(
        async () => /realtime_events_total\{outcome="stale"\} 1\b/.test(await (await fetch(metrics)).text()),
        "o evento de antes da volta descartado como stale",
      );
      const client = await followingClient(started.url, await issuer.operatorToken(), [walletId]);
      const afterRestart = balanceChangedEnvelope(walletId, 3);
      await publishEnvelope(topic.topicArn, afterRestart);
      await client.waitFor((message) => message.eventId === afterRestart.eventId, "evento de depois da volta");
      client.close();

      expect(client.events().map((event) => event.eventId)).toEqual([afterRestart.eventId]);
      expect(await instanceQueueUrl(started.instanceId)).toBe(queueUrl);
      expect((await instanceSubscriptions(topic.topicArn, started.instanceId)).length).toBe(1);
    } finally {
      await group.close();
    }
  }, SLOW_TEST_MS);
});

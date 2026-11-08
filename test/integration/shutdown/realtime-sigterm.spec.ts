import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { startTestIssuer, type TestIssuer } from "../../support/auth";
import { createTestTopic, type TestTopic } from "../../support/outbox";
import { ProcessGroup } from "../../support/processes";
import { deleteInstanceQueue, instanceQueueUrl, instanceSubscriptions, spawnRealtime } from "../../support/realtime";
import { followingClient } from "../../support/ws-client";

/**
 * D21.2 D28.5: o mesmo SIGTERM real dos outros processos (`sigterm.spec.ts`),
 * no `realtime`. Fora do Windows; o CI conta 7 (D25.3, D28.12).
 */
const isWindows = process.platform === "win32";
const COMPOSE_GRACE_MS = 30_000;

let group: ProcessGroup;
let topic: TestTopic;
let issuer: TestIssuer;
let instanceId: string | undefined;

beforeEach(async () => {
  group = new ProcessGroup("realtime-sigterm");
  topic = await createTestTopic();
  issuer = await startTestIssuer();
});

afterEach(async () => {
  await group.close();
  if (instanceId !== undefined) await deleteInstanceQueue(instanceId);
  await issuer.stop();
  await topic.destroy();
});

describe.skipIf(isWindows)("D8.5 D21.2 D28.5: SIGTERM real no realtime", () => {
  it("D8.5 D21.2 D28.5: realtime recebe SIGTERM → fecha os sockets com 1001, deixa a fila e a assinatura da infra e sai dentro dos 30 s do Compose", async () => {
    const started = await spawnRealtime(group, { topicArn: topic.topicArn, issuer });
    instanceId = started.instanceId;
    const client = await followingClient(started.url, await issuer.operatorToken(), [Bun.randomUUIDv7()]);

    const begin = performance.now();
    await started.process.terminate();
    const elapsed = performance.now() - begin;

    expect(elapsed).toBeLessThan(COMPOSE_GRACE_MS);
    expect((await client.closed).code).toBe(1001);
    expect((await instanceSubscriptions(topic.topicArn, started.instanceId)).length).toBe(1);
    expect(await instanceQueueUrl(started.instanceId)).toBeDefined();
    expect(started.process.lines.some((line) => line.includes('"msg":"realtime parado"'))).toBe(true);
  }, COMPOSE_GRACE_MS + 30_000);
});

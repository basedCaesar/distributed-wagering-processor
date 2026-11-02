import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ListTopicsCommand, PublishCommand } from "@aws-sdk/client-sns";
import { createSnsClient } from "../../../src/shared/aws/sns-client";
import { type HoldingProxy, startHoldingProxy } from "../../support/holding-proxy";
import { createTestTopic, type TestTopic } from "../../support/outbox";

/** Abaixo do lease de qualquer config válida (D20.5): 1 s no teste. */
const SNS_TIMEOUT_MS = 1000;

let proxy: HoldingProxy;
let topic: TestTopic;

beforeEach(async () => {
  proxy = await startHoldingProxy(process.env.AWS_ENDPOINT ?? "");
  topic = await createTestTopic();
});

afterEach(async () => {
  proxy.release();
  await proxy.close();
  await topic.destroy();
});

describe("D20.5: o timeout do SNS vale de verdade", () => {
  it("D20.5: SNS que aceita a conexão e não responde → o Publish falha no requestTimeout, antes do lease (sem isso, o publisher fica preso para sempre)", async () => {
    const client = createSnsClient(
      { region: process.env.AWS_REGION ?? "us-east-1", endpoint: proxy.url },
      { requestTimeoutMs: SNS_TIMEOUT_MS },
    );
    // Conexão keep-alive aberta e funcionando antes de segurar.
    await client.send(new ListTopicsCommand({}));
    proxy.hold();

    const started = performance.now();
    const outcome = await client
      .send(
        new PublishCommand({
          TopicArn: topic.topicArn,
          Message: "{}",
          MessageGroupId: "sns-timeout",
          MessageDeduplicationId: Bun.randomUUIDv7(),
        }),
      )
      .then(
        () => "respondeu",
        (error: unknown) => (error instanceof Error ? error.name : "erro"),
      );
    const elapsed = performance.now() - started;

    expect(outcome).toBe("TimeoutError");
    // No prazo (com folga para o relógio), longe de qualquer lease.
    expect(elapsed).toBeLessThan(SNS_TIMEOUT_MS + 1500);
    client.destroy();
  }, 15_000);
});

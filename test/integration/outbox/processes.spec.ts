import { describe, expect, it } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import type { INestApplicationContext } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { EventAuditorAppModule } from "../../../src/app/event-auditor.module";
import { OutboxPublisherAppModule } from "../../../src/app/outbox-publisher.module";
import { EventAuditor } from "../../../src/modules/wagering/infra/messaging/event-auditor";
import { OutboxPublisher } from "../../../src/modules/wagering/infra/outbox/outbox-publisher";
import { loadConfig } from "../../../src/shared/config/config";
import { APP_CONFIG } from "../../../src/shared/config/config.module";
import { auditedRows, envelopeJson } from "../../support/auditor";
import { newId, withClient } from "../../support/db";
import {
  createTestTopic,
  drainEnvelopes,
  insertOutboxEvent,
  outboxRow,
  parkAllOutbox,
} from "../../support/outbox";
import { createTestQueues, queueCounts, sendMessage } from "../../support/sqs";

/** O `stop()` do auditor espera o long poll de 20 s do processo (D19.9). */
const NEST_TEST_MS = 45_000;

/**
 * Registra a ordem dos dois hooks de shutdown: o `stop()` do laço tem de
 * terminar antes de o ORM começar a fechar.
 */
function recordShutdownOrder(moduleRef: TestingModule, loop: { stop(): Promise<void> }): string[] {
  const hooks: string[] = [];
  const stop = loop.stop.bind(loop);
  loop.stop = async () => {
    await stop();
    hooks.push("stop terminou");
  };
  const orm = moduleRef.get(MikroORM);
  const close = orm.close.bind(orm);
  orm.close = async (force?: boolean) => {
    hooks.push("orm.close começou");
    await close(force);
  };
  return hooks;
}

/** Espera uma condição (estado observável, sem `sleep`). */
async function waitUntil(condition: () => Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`${what} em ${timeoutMs} ms`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("D7.4 D8.6 D9.6: o processo outbox-publisher (Nest)", () => {
  it("D7.4 D20.9: o OutboxPublisherAppModule resolve o tópico pelo nome, publica e, no shutdown, o stop() termina antes de o ORM fechar", async () => {
    await parkAllOutbox();
    const topic = await createTestTopic();
    let app: INestApplicationContext | undefined;
    try {
      const { id } = await withClient("app", (client) => insertOutboxEvent(client, { walletId: newId() }));
      const config = loadConfig();
      const moduleRef = await Test.createTestingModule({ imports: [OutboxPublisherAppModule] })
        .overrideProvider(APP_CONFIG)
        .useValue({ ...config, aws: { ...config.aws, sns: { wageringEventsTopic: topic.topicName } } })
        .compile();
      const publisher = moduleRef.get(OutboxPublisher);
      const hooks = recordShutdownOrder(moduleRef, publisher);
      app = await moduleRef.init();

      publisher.start();
      await waitUntil(async () => (await outboxRow(id)).published, "o publisher não publicou");
      await app.close();
      app = undefined;

      expect(hooks).toEqual(["stop terminou", "orm.close começou"]);
      expect((await drainEnvelopes(topic.queueUrl, 1)).map((r) => r.eventId)).toEqual([id]);
    } finally {
      await app?.close();
      await topic.destroy();
    }
  }, NEST_TEST_MS);
});

describe("D7.4 D8.5 D9.7: o processo event-auditor (Nest)", () => {
  it("D7.4 D20.2: o EventAuditorAppModule consome a fila configurada e, no shutdown, o stop() termina antes de o ORM fechar", async () => {
    const queues = await createTestQueues();
    let app: INestApplicationContext | undefined;
    try {
      const walletId = newId();
      const event = envelopeJson({ walletId, walletVersion: 2 });
      await sendMessage(queues.queueUrl, event.body, { groupId: walletId });
      const config = loadConfig();
      const moduleRef = await Test.createTestingModule({ imports: [EventAuditorAppModule] })
        .overrideProvider(APP_CONFIG)
        .useValue({
          ...config,
          aws: {
            ...config.aws,
            queues: {
              ...config.aws.queues,
              wageringEventsAuditor: queues.queueName,
              wageringEventsAuditorDlq: queues.dlqName,
            },
          },
        })
        .compile();
      const auditor = moduleRef.get(EventAuditor);
      const hooks = recordShutdownOrder(moduleRef, auditor);
      app = await moduleRef.init();

      auditor.start();
      await waitUntil(async () => (await auditedRows([event.eventId])).length === 1, "o auditor não auditou");
      await app.close();
      app = undefined;

      expect(hooks).toEqual(["stop terminou", "orm.close começou"]);
      expect(await queueCounts(queues.queueUrl)).toEqual({ visible: 0, inFlight: 0 });
    } finally {
      await app?.close();
      await queues.destroy();
    }
  }, NEST_TEST_MS);
});

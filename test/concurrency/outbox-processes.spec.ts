import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { newId, withClient } from "../support/db";
import {
  createTestTopic,
  drainEnvelopes,
  insertOutboxEvent,
  parkAllOutbox,
  type SeededEvent,
  type TestTopic,
  unpublishedCount,
} from "../support/outbox";
import { ProcessGroup, PUBLISH_PREFIX, waitFor } from "../support/processes";

/** Dois processos Bun subindo, 50 eventos pelo LocalStack e o dreno da fila. */
const SLOW_TEST_MS = 90_000;
const CHILD = join("test", "support", "processes", "outbox-publisher-child.ts");

let topic: TestTopic;
let group: ProcessGroup;

beforeEach(async () => {
  topic = await createTestTopic();
  await parkAllOutbox();
  group = new ProcessGroup("r-13-c6-processos");
});

afterEach(async () => {
  await group.close();
  await topic.destroy();
});

/** `wallets` wallets com `perWallet` eventos cada, versões 2, 3, … em ordem de gravação. */
async function seedWallets(wallets: number, perWallet: number): Promise<Map<string, SeededEvent[]>> {
  const byWallet = new Map<string, SeededEvent[]>();
  await withClient("app", async (client) => {
    for (let w = 0; w < wallets; w++) {
      const walletId = newId();
      const events: SeededEvent[] = [];
      for (let v = 2; v < 2 + perWallet; v++) {
        events.push(await insertOutboxEvent(client, { walletId, walletVersion: v }));
      }
      byWallet.set(walletId, events);
    }
  });
  return byWallet;
}

/** `eventId` → chamadas a `Publish`, somadas das linhas `PUBLISH …` dos processos (D21.4). */
function publishCounts(lines: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    if (!line.startsWith(PUBLISH_PREFIX)) continue;
    const { eventId } = JSON.parse(line.slice(PUBLISH_PREFIX.length)) as { eventId: string };
    counts.set(eventId, (counts.get(eventId) ?? 0) + 1);
  }
  return counts;
}

describe("R-13-C6 D7.4 D21.4: dois publishers em processos separados sobre a mesma outbox", () => {
  it("R-13-C6 R-13-I4 D20.6 D21.4: 10 wallets × 5 eventos, dois publishers em processos separados → cada eventId publicado uma vez e em ordem de walletVersion por wallet", async () => {
    const env = { SNS_TOPIC_WAGERING_EVENTS: topic.topicName };
    // Os dois sobem antes da carga, para disputarem a outbox desde o 1º claim.
    const [a, b] = await Promise.all([
      group.spawn("outbox-publisher", { instance: "publisher-a", entrypoint: CHILD, env }),
      group.spawn("outbox-publisher", { instance: "publisher-b", entrypoint: CHILD, env }),
    ]);
    const seeded = await seedWallets(10, 5);
    const walletIds = [...seeded.keys()];

    const all = [...seeded.values()].flat();
    await waitFor(async () => (await unpublishedCount(walletIds)) === 0, "a outbox do teste publicada", 60_000);
    // O kill espera o stdout drenar, e o child escreve de forma síncrona: nenhuma linha se perde.
    await Promise.all([a.kill(), b.kill()]);

    const counts = publishCounts([...a.lines, ...b.lines]);
    // Cada evento saiu uma vez, contado antes da deduplicação do SNS FIFO (D20.6).
    expect(all.map((event) => counts.get(event.id))).toEqual(all.map(() => 1));
    expect([...counts.keys()].filter((id) => !all.some((event) => event.id === id))).toEqual([]);

    const received = await drainEnvelopes(topic.queueUrl, all.length, 15_000);
    expect(received).toHaveLength(all.length);
    for (const [walletId, events] of seeded) {
      const ofWallet = received.filter((r) => r.groupId === walletId);
      expect(ofWallet.map((r) => r.eventId)).toEqual(events.map((e) => e.id));
      const versions = ofWallet.map((r) => (r.body.data as { walletVersion: number }).walletVersion);
      expect(versions).toEqual([2, 3, 4, 5, 6]);
    }
  }, SLOW_TEST_MS);
});

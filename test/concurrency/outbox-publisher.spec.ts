import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { connect, newId, withClient } from "../support/db";
import {
  countingPublishes,
  createTestTopic,
  drainEnvelopes,
  insertOutboxEvent,
  outboxRow,
  parkAllOutbox,
  type SeededEvent,
  startTestPublisher,
  type TestPublisher,
  type TestTopic,
  unpublishedCount,
} from "../support/outbox";

/** 50 eventos passando pelo LocalStack não cabem nos 5 s padrão do bun. */
const SLOW_TEST_MS = 30_000;

let topic: TestTopic;
const publishers: TestPublisher[] = [];

beforeEach(async () => {
  topic = await createTestTopic();
  await parkAllOutbox();
});

afterEach(async () => {
  for (const publisher of publishers.splice(0)) await publisher.close();
  await topic.destroy();
});

async function publisherFor(options: Parameters<typeof startTestPublisher>[1] = {}): Promise<TestPublisher> {
  const publisher = await startTestPublisher(topic, options);
  publishers.push(publisher);
  return publisher;
}

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

/** Espera uma condição do banco (estado observável, sem `sleep`). */
async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`condição não atingida em ${timeoutMs} ms`);
}

describe("R-13-C6 R-13-I4 R-11-02: dois publishers sobre a mesma outbox", () => {
  it("R-13-C6 R-13-I4 D20.6: 10 wallets × 5 eventos, dois publishers em laço → cada eventId publicado uma vez (contado no SNS) e em ordem de walletVersion por wallet", async () => {
    const seeded = await seedWallets(10, 5);
    const walletIds = [...seeded.keys()];
    const counts = new Map<string, number>();
    const a = await publisherFor({ wrapSns: countingPublishes(counts) });
    const b = await publisherFor({ wrapSns: countingPublishes(counts) });

    a.publisher.start();
    b.publisher.start();
    await waitUntil(async () => (await unpublishedCount(walletIds)) === 0);
    await a.publisher.stop();
    await b.publisher.stop();

    const all = [...seeded.values()].flat();
    // Cada evento saiu uma vez, contado antes da deduplicação do SNS FIFO (D20.6).
    expect(all.map((event) => counts.get(event.id))).toEqual(all.map(() => 1));
    expect(counts.size).toBe(all.length);

    const received = await drainEnvelopes(topic.queueUrl, all.length, 15_000);
    expect(received).toHaveLength(all.length);
    for (const [walletId, events] of seeded) {
      const ofWallet = received.filter((r) => r.groupId === walletId);
      expect(ofWallet.map((r) => r.eventId)).toEqual(events.map((e) => e.id));
      const versions = ofWallet.map((r) => (r.body.data as { walletVersion: number }).walletVersion);
      expect(versions).toEqual([2, 3, 4, 5, 6]);
    }
  }, SLOW_TEST_MS);

  it("R-13-C6 D20.3: claim de A em andamento (cabeça travada) → B pula essa wallet sem esperar e não pega o 2º evento dela", async () => {
    const seeded = await seedWallets(2, 2);
    const [locked, free] = [...seeded.entries()];
    if (!locked || !free) throw new Error("seed sem as duas wallets");
    const [lockedHead, lockedNext] = locked[1];
    const [freeHead] = free[1];
    if (!lockedHead || !lockedNext || !freeHead) throw new Error("seed sem os eventos esperados");
    const b = await publisherFor();

    // A trava a cabeça como o claim dele faria, e não commita.
    const a = await connect("app");
    let round: Awaited<ReturnType<TestPublisher["runOnce"]>>;
    let elapsed: number;
    try {
      await a.query("BEGIN");
      await a.query("SELECT id FROM outbox_messages WHERE id = $1 FOR UPDATE", [lockedHead?.id]);
      const started = Date.now();
      round = await b.runOnce();
      elapsed = Date.now() - started;
    } finally {
      await a.query("ROLLBACK");
      await a.end();
    }

    expect(round.published).toEqual([freeHead?.id]);
    // Sem SKIP LOCKED, B esperaria o lock (até o lock_timeout de 2 s) em vez de pular.
    expect(elapsed).toBeLessThan(1_500);
    expect((await outboxRow(lockedNext?.id as string)).published).toBe(false);
    expect((await outboxRow(lockedHead?.id as string)).published).toBe(false);
  }, SLOW_TEST_MS);
});

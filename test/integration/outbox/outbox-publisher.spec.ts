import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { PublishCommand } from "@aws-sdk/client-sns";
import type { SnsSender } from "../../../src/modules/wagering/infra/outbox/sns-event-publisher";
import { startTestApi } from "../../support/api";
import { connect, newId, withClient } from "../../support/db";
import { expectLedgerMatchesBalances } from "../../support/db-ledger-invariant";
import {
  createTestTopic,
  drainEnvelopes,
  insertOutboxEvent,
  outboxIdsOf,
  outboxRow,
  parkAllOutbox,
  runPublisherUntil,
  startTestPublisher,
  type TestPublisher,
  type TestTopic,
  unpublishedCount,
} from "../../support/outbox";
import { brl, createWallet, submit, wagerBody } from "../../support/wagering";

/** A espera do lease (1 s) e a subida da API não cabem nos 5 s padrão do bun. */
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
  await expectLedgerMatchesBalances();
});

async function publisherFor(options: Parameters<typeof startTestPublisher>[1] = {}): Promise<TestPublisher> {
  const publisher = await startTestPublisher(topic, options);
  publishers.push(publisher);
  return publisher;
}

async function seed(walletId: string, options: { eventType?: string; walletVersion?: number } = {}) {
  return withClient("app", (client) => insertOutboxEvent(client, { walletId, ...options }));
}

/** SNS que falha com conexão recusada nas primeiras `failures` chamadas. */
function failingSns(failures: number) {
  let left = failures;
  return (client: SnsSender): SnsSender => ({
    send(command) {
      if (left > 0) {
        left -= 1;
        return Promise.reject(Object.assign(new Error("SNS fora"), { code: "ECONNREFUSED" }));
      }
      return client.send(command);
    },
  });
}

describe("R-05-04 D9: nada publicado antes do commit", () => {
  it("R-05-04: evento gravado numa transação ainda aberta → o publisher não o vê; depois do commit, publica", async () => {
    const publisher = await publisherFor();
    const open = await connect("app");
    let eventId: string;
    try {
      await open.query("BEGIN");
      eventId = (await insertOutboxEvent(open, { walletId: newId() })).id;

      expect(await publisher.runOnce()).toEqual({ claimed: 0, published: [], failed: [] });
      expect(await drainEnvelopes(topic.queueUrl, 1, 1500)).toEqual([]);

      await open.query("COMMIT");
    } finally {
      await open.end();
    }

    expect((await publisher.runOnce()).published).toEqual([eventId]);
    expect((await drainEnvelopes(topic.queueUrl, 1)).map((r) => r.eventId)).toEqual([eventId]);
    expect((await outboxRow(eventId)).published).toBe(true);
  });
});

describe("R-11-03 D9.6 D20.5: o processo morre e outra instância publica", () => {
  it("R-11-03: eventos commitados sem publisher rodando → outra instância publica todos, na ordem da outbox", async () => {
    // A API grava e "morre" para a outbox: nenhum publisher roda com ela.
    const api = await startTestApi();
    let walletId: string;
    try {
      const wallet = await createWallet(api, brl("100.00"));
      walletId = wallet.id;
      expect((await submit(api, wagerBody(wallet))).status).toBe(200);
    } finally {
      await api.close();
    }
    const expected = await outboxIdsOf(walletId);
    expect(expected.length).toBeGreaterThanOrEqual(4);

    const other = await publisherFor();
    await runPublisherUntil(other, async () => (await unpublishedCount([walletId])) === 0);

    const received = await drainEnvelopes(topic.queueUrl, expected.length);
    expect(received.map((r) => r.eventId)).toEqual(expected);
    expect(new Set(received.map((r) => r.groupId))).toEqual(new Set([walletId]));
  }, SLOW_TEST_MS);

  it("R-11-03 D20.5: o publisher A morre depois do claim (SNS que nunca responde) → o lease vence, B publica; a falha tardia de A não conta", async () => {
    const walletId = newId();
    const { id } = await seed(walletId);

    let hung: ((error: Error) => void) | undefined;
    let published: (() => void) | undefined;
    const reachedSns = new Promise<void>((resolve) => {
      published = resolve;
    });
    const neverAnswers = (_client: SnsSender): SnsSender => ({
      send(command) {
        if (command instanceof PublishCommand) published?.();
        return new Promise((_, reject) => {
          hung = reject;
        });
      },
    });
    const dying = await publisherFor({ wrapSns: neverAnswers, policy: { leaseMs: 1000 } });
    const survivor = await publisherFor();

    const dyingRound = dying.runOnce();
    await reachedSns;
    expect(await survivor.runOnce()).toEqual({ claimed: 0, published: [], failed: [] });

    // O lease de 1 s vence (estado observável: o claim de B passa a pegar).
    const deadline = Date.now() + 5000;
    let round = await survivor.runOnce();
    while (round.claimed === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setImmediate(resolve));
      round = await survivor.runOnce();
    }
    expect(round.published).toEqual([id]);
    expect((await drainEnvelopes(topic.queueUrl, 1)).map((r) => r.eventId)).toEqual([id]);

    // A "volta" com erro: o lease já é de B, então nada é registrado.
    hung?.(Object.assign(new Error("conexão caiu"), { code: "ECONNRESET" }));
    expect((await dyingRound).failed).toEqual([id]);
    expect(await outboxRow(id)).toMatchObject({ published: true, attempts: 0, last_error_code: null, locked_by: null });
  }, SLOW_TEST_MS);
});

describe("D9.2 D20.3: ordem por wallet", () => {
  it("D9.2 D20.3: com a cabeça de uma wallet em backoff, o evento seguinte dela não sai; as outras wallets saem", async () => {
    const blocked = newId();
    const free = newId();
    const head = await seed(blocked, { walletVersion: 2 });
    const next = await seed(blocked, { walletVersion: 3 });
    const other = await seed(free, { walletVersion: 2 });
    await withClient("app", (client) =>
      client.query("UPDATE outbox_messages SET next_attempt_at = now() + interval '1 hour' WHERE id = $1", [head.id]),
    );
    const publisher = await publisherFor();

    expect((await publisher.runOnce()).published).toEqual([other.id]);
    expect(await publisher.runOnce()).toEqual({ claimed: 0, published: [], failed: [] });
    expect((await outboxRow(next.id)).published).toBe(false);
  });

  it("D20.3: um evento por wallet por claim; a 2ª rodada pega o seguinte", async () => {
    const walletId = newId();
    const first = await seed(walletId, { walletVersion: 2 });
    const second = await seed(walletId, { walletVersion: 3 });
    const publisher = await publisherFor();

    expect((await publisher.runOnce()).published).toEqual([first.id]);
    expect((await publisher.runOnce()).published).toEqual([second.id]);
    expect((await drainEnvelopes(topic.queueUrl, 2)).map((r) => r.eventId)).toEqual([first.id, second.id]);
  });
});

describe("D9.6 D20.4: falha ao publicar", () => {
  it("D9.6 D20.4: SNS fora → tentativa + 1, backoff de 2 s, lease solto, nada descartado; SNS de volta → publica", async () => {
    const { id } = await seed(newId());
    const publisher = await publisherFor({ wrapSns: failingSns(1) });

    expect(await publisher.runOnce()).toEqual({ claimed: 1, published: [], failed: [id] });

    const failed = await outboxRow(id);
    expect(failed).toMatchObject({
      published: false,
      attempts: 1,
      last_error_code: "TEMPORARILY_UNAVAILABLE",
      locked_by: null,
      leased: false,
    });
    expect(failed.due_in_seconds).toBeGreaterThan(1);
    expect(failed.due_in_seconds).toBeLessThanOrEqual(2);
    // Em backoff: a rodada seguinte não pega.
    expect((await publisher.runOnce()).claimed).toBe(0);

    await withClient("app", (client) =>
      client.query("UPDATE outbox_messages SET next_attempt_at = now() WHERE id = $1", [id]),
    );
    expect((await publisher.runOnce()).published).toEqual([id]);
    expect(await outboxRow(id)).toMatchObject({ published: true, attempts: 1 });
    expect((await drainEnvelopes(topic.queueUrl, 1)).map((r) => r.eventId)).toEqual([id]);
  });
});

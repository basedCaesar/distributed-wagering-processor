import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { startTestApi } from "../support/api";
import { expectLedgerMatchesBalances } from "../support/db-ledger-invariant";
import {
  createTestTopic,
  parkAllOutbox,
  runPublisherUntil,
  startTestPublisher,
  type TestTopic,
  unpublishedCount,
} from "../support/outbox";
import { ProcessGroup } from "../support/processes";
import { deleteInstanceQueue, spawnRealtime } from "../support/realtime";
import { brl, createWallet, submit, wagerBody } from "../support/wagering";
import { balanceVersions, followingClient } from "../support/ws-client";

const SLOW_TEST_MS = 120_000;
const BETS = 50;

let group: ProcessGroup;
let topic: TestTopic;
const instances: string[] = [];

beforeEach(async () => {
  group = new ProcessGroup("realtime-concurrency");
  topic = await createTestTopic();
  await parkAllOutbox();
});

afterEach(async () => {
  await group.close();
  for (const id of instances.splice(0)) await deleteInstanceQueue(id);
  await topic.destroy();
});

describe("D28.8 D9.2: ordem por wallet com BETs em paralelo e duas instâncias", () => {
  it(`D28.8 D9.2: ${BETS} BETs em paralelo na mesma wallet → cada cliente, nas duas instâncias, vê as versões em ordem e sem furo`, async () => {
    const api = await startTestApi();
    const publisher = await startTestPublisher(topic);
    try {
      const one = await spawnRealtime(group, { topicArn: topic.topicArn, issuer: api.issuer });
      const two = await spawnRealtime(group, { topicArn: topic.topicArn, issuer: api.issuer });
      instances.push(one.instanceId, two.instanceId);
      const wallet = await createWallet(api, brl("1000.00"));
      const operatorToken = await api.issuer.operatorToken();
      const providerToken = await api.issuer.providerToken("provider-a");
      const clients = [
        await followingClient(one.url, operatorToken, [wallet.id]),
        await followingClient(one.url, providerToken, [wallet.id]),
        await followingClient(two.url, operatorToken, [wallet.id]),
        await followingClient(two.url, providerToken, [wallet.id]),
      ];

      const results = await Promise.all(
        Array.from({ length: BETS }, () => submit(api, wagerBody(wallet, { kind: "BET", money: brl("1.00") }))),
      );
      const processed = results.filter((result) => result.status === 200).length;
      expect(processed).toBeGreaterThan(0);
      // O publisher solta um evento por wallet por rodada (D9.2): ~2 eventos por commit.
      await runPublisherUntil(publisher, async () => (await unpublishedCount([wallet.id])) === 0, 4 * (BETS + 2));

      const expected = Array.from({ length: processed + 1 }, (_, index) => index + 1);
      // Operador: a OPENING e as BETs; provedor A: só as BETs dele.
      const expectedTransactions = [processed + 1, processed, processed + 1, processed];
      const transactionsOf = (client: (typeof clients)[number]) =>
        client.events().filter((event) => event.eventType === "WagerTransactionProcessed").length;
      for (const [index, client] of clients.entries()) {
        await client.waitFor(
          (message) => message.type === "event" && message.eventType === "WalletBalanceChanged" && message.walletVersion === processed + 1,
          `v${processed + 1}`,
          60_000,
        );
        await client.waitFor(() => transactionsOf(client) >= (expectedTransactions[index] ?? 0), "transações", 60_000);
        expect(balanceVersions(client, wallet.id)).toEqual(expected);
      }
      expect(clients.map(transactionsOf)).toEqual(expectedTransactions);
      for (const client of clients) client.close();
    } finally {
      await publisher.close();
      await api.close();
    }
    await expectLedgerMatchesBalances();
  }, SLOW_TEST_MS);
});

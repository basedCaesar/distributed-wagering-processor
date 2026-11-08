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

type Client = Awaited<ReturnType<typeof followingClient>>;

/** Quantos eventos de cada tipo o cliente recebeu. */
function countByType(client: Client): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of client.events()) counts[event.eventType] = (counts[event.eventType] ?? 0) + 1;
  return counts;
}

/** As `walletVersion` dos eventos de um tipo, na ordem de chegada. */
function versionsOf(client: Client, eventType: string): (number | null)[] {
  return client
    .events()
    .filter((event) => event.eventType === eventType)
    .map((event) => event.walletVersion);
}

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, index) => from + index);

/*
 * A ordem que o cliente vê vem do FIFO por wallet (grupo = walletId) e do
 * publisher, que solta um evento por wallet por rodada (D9.1, D9.2). O laço
 * sequencial do realtime (D28.7) é provado no teste de unidade
 * `test/unit/realtime/event-loop.spec.ts`: aqui ele não faria diferença,
 * porque a entrega aos sockets é síncrona antes do delete.
 */
describe("D9.1 D9.2 D28.8: a ordem do FIFO por wallet e do publisher chega aos clientes das duas instâncias", () => {
  it(`D9.1 D9.2 D28.8: ${BETS} BETs em paralelo na mesma wallet → todas contadas; cada cliente, nas duas instâncias, recebe exatamente os eventos esperados, com as versões contíguas e em ordem`, async () => {
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
      // Toda BET tem desfecho de negócio: PROCESSED (200) ou REJECTED (422). Nenhuma some.
      const processed = results.filter((result) => result.status === 200).length;
      const rejected = results.filter((result) => result.status === 422).length;
      expect({ processed, rejected, total: processed + rejected }).toEqual({ processed, rejected, total: BETS });
      // O publisher solta um evento por wallet por rodada (D9.2): ~2 eventos por commit.
      await runPublisherUntil(publisher, async () => (await unpublishedCount([wallet.id])) === 0, 4 * (BETS + 2));

      // Os eventos da wallet vão para todos; os de transação, ao operador (com a
      // OPENING, de providerId nulo) e ao provedor A (só as BETs dele), D28.3.
      const walletEvents = { WalletOpened: 1, WalletBalanceChanged: processed + 1 };
      const asOperator = {
        ...walletEvents,
        WagerTransactionProcessed: processed + 1,
        ...(rejected > 0 && { WagerTransactionRejected: rejected }),
      };
      const asProvider = {
        ...walletEvents,
        WagerTransactionProcessed: processed,
        ...(rejected > 0 && { WagerTransactionRejected: rejected }),
      };
      const expected = [asOperator, asProvider, asOperator, asProvider];
      const total = (counts: Record<string, number>) => Object.values(counts).reduce((sum, count) => sum + count, 0);

      for (const [index, client] of clients.entries()) {
        const want = expected[index] ?? {};
        await client.waitFor(() => client.events().length >= total(want), `${total(want)} eventos no cliente ${index}`, 60_000);
      }
      for (const [index, client] of clients.entries()) {
        const asOp = index % 2 === 0;
        expect({ client: index, counts: countByType(client) }).toEqual({ client: index, counts: expected[index] ?? {} });
        // Nenhuma duplicata.
        const ids = client.events().map((event) => event.eventId);
        expect(new Set(ids).size).toBe(ids.length);
        // Versões contíguas e em ordem: v1..v(n+1) no saldo; nas transações processadas, a partir da OPENING (operador) ou da 1ª BET.
        expect(balanceVersions(client, wallet.id)).toEqual(range(1, processed + 1));
        expect(versionsOf(client, "WagerTransactionProcessed")).toEqual(range(asOp ? 1 : 2, processed + 1));
        expect(versionsOf(client, "WalletOpened")).toEqual([1]);
      }
      for (const client of clients) client.close();
    } finally {
      await publisher.close();
      await api.close();
    }
    await expectLedgerMatchesBalances();
  }, SLOW_TEST_MS);
});

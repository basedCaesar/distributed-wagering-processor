import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { startTestApi } from "../../support/api";
import { expectLedgerMatchesBalances } from "../../support/db-ledger-invariant";
import {
  createTestTopic,
  parkAllOutbox,
  runPublisherUntil,
  startTestPublisher,
  type TestTopic,
  unpublishedCount,
} from "../../support/outbox";
import { ProcessGroup, waitFor } from "../../support/processes";
import { deleteInstanceQueue, spawnRealtime } from "../../support/realtime";
import { brl, createWallet, submit, wagerBody } from "../../support/wagering";
import { balanceVersions, followingClient, openClient } from "../../support/ws-client";

const SLOW_TEST_MS = 90_000;

let group: ProcessGroup;
let topic: TestTopic;
const instances: string[] = [];

beforeEach(async () => {
  group = new ProcessGroup("realtime-processes");
  topic = await createTestTopic();
  await parkAllOutbox();
});

afterEach(async () => {
  await group.close();
  for (const id of instances.splice(0)) await deleteInstanceQueue(id);
  await topic.destroy();
});

describe("D28.5 D28.11: duas instâncias do realtime em processos separados", () => {
  // Os fechamentos 1011 e a falha de entrega não têm como ser provocados num processo real: estão em test/unit/realtime/sensitive-logs.spec.ts.
  it("D28.5 V-03 D11.1: cada cliente recebe o evento na instância em que está conectado (fan-out por fila de instância); os logs, inclusive os dos fechamentos 4401, não levam dado sensível", async () => {
    const api = await startTestApi();
    const publisher = await startTestPublisher(topic);
    try {
      const one = await spawnRealtime(group, { topicArn: topic.topicArn, issuer: api.issuer });
      const two = await spawnRealtime(group, { topicArn: topic.topicArn, issuer: api.issuer });
      instances.push(one.instanceId, two.instanceId);
      const wallet = await createWallet(api, brl("100.00"));
      const providerToken = await api.issuer.providerToken("provider-a");
      const onOne = await followingClient(one.url, await api.issuer.operatorToken(), [wallet.id]);
      const onTwo = await followingClient(two.url, providerToken, [wallet.id]);

      const bet = await submit(api, wagerBody(wallet, { kind: "BET", money: brl("25.00") }));
      expect(bet.status).toBe(200);
      await runPublisherUntil(publisher, async () => (await unpublishedCount([wallet.id])) === 0);

      for (const client of [onOne, onTwo]) {
        await client.waitFor(
          (message) => message.type === "event" && message.eventType === "WalletBalanceChanged" && message.walletVersion === 2,
          "v2 nas duas instâncias",
        );
        expect(balanceVersions(client, wallet.id)).toEqual([1, 2]);
        client.close();
      }

      // Fechamentos que logam (D28.2): token recusado numa instância, token que vence durante a conexão na outra.
      const refusedToken = await api.issuer.token({ foreignKey: true });
      const refused = await openClient(one.url);
      refused.send({ type: "auth", token: refusedToken });
      expect((await refused.closed).code).toBe(4401);
      const expiringToken = await api.issuer.token({ roles: ["operator"], providerId: null, expiresIn: 2 });
      const expiring = await followingClient(two.url, expiringToken, [wallet.id]);
      expect((await expiring.closed).code).toBe(4401);
      for (const instance of [one, two]) {
        await waitFor(() => instance.process.lines.some((line) => line.includes('"closeCode":4401')), "log do fechamento 4401");
      }

      // D11.1 D28.11: nenhuma linha dos dois processos traz token, valor, saldo ou playerId.
      const lines = [...one.process.lines, ...two.process.lines];
      expect(lines.some((line) => line.includes('"msg":"realtime iniciado"'))).toBe(true);
      const leaks = lines.filter((line) =>
        [providerToken, refusedToken, expiringToken, wallet.playerId, "25.00", "75.00", "100.00", "balance", "authorization"].some((secret) =>
          line.toLowerCase().includes(secret.toLowerCase()),
        ),
      );
      expect(leaks).toEqual([]);
    } finally {
      await publisher.close();
      await api.close();
    }
    await expectLedgerMatchesBalances();
  }, SLOW_TEST_MS);
});

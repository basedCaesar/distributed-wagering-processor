import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { WalletBody } from "../support/api";
import { startTestIssuer, type TestIssuer } from "../support/auth";
import { effectsOf, wagerMessage } from "../support/consumer";
import { connect, newId } from "../support/db";
import { expectLedgerMatchesBalances } from "../support/db-ledger-invariant";
import { apiClient, authEnv, ProcessGroup, waitFor, walletLockWaiterApps } from "../support/processes";
import { createTestQueues, queueCounts, sendMessage, type TestQueues } from "../support/sqs";
import {
  type ApiClient,
  brl,
  createWallet,
  holdWalletLock,
  submit,
  WAITERS_DEADLINE_MS,
  wagerBody,
} from "../support/wagering";

/** Seis processos Bun subindo, mais a carga pelos dois canais. */
const SLOW_TEST_MS = 90_000;
const APIS = ["api-1", "api-2", "api-3"];
const CONSUMERS = ["consumer-1", "consumer-2", "consumer-3"];

let issuer: TestIssuer;
let queues: TestQueues;
let group: ProcessGroup;

beforeEach(async () => {
  issuer = await startTestIssuer();
  queues = await createTestQueues();
  group = new ProcessGroup("r-13-c4");
});

afterEach(async () => {
  await group.close();
  await queues.destroy();
  await issuer.stop();
});

describe("R-13-C4 R-05-08 R-08-06 D7.4 D21.1: três ou mais processos sobre a mesma wallet", () => {
  it("R-13-C4 R-05-08 R-08-06 D21.1: 3 api e 3 consumer em processos separados, carga simultânea na mesma wallet (waiters de 3 processos no pg_locks) → um efeito por key, saldo = ledger, version coerente", async () => {
    const env = {
      ...authEnv(issuer),
      QUEUE_WAGER_TRANSACTIONS: queues.queueName,
      QUEUE_WAGER_TRANSACTIONS_DLQ: queues.dlqName,
    };
    const started = await Promise.all([
      ...APIS.map((instance) => group.spawn("api", { instance, env })),
      ...CONSUMERS.map((instance) => group.spawn("consumer", { instance, env })),
    ]);
    const apis: ApiClient[] = started.filter((p) => p.kind === "api").map((p) => apiClient(p, issuer));
    const [api1, api2, api3] = apis;
    if (!api1 || !api2 || !api3) throw new Error("as 3 api não subiram");
    const wallet = await createWallet(api1, brl("1000.00"));

    // 9 BETs únicas pelo HTTP, 3 por processo; uma key repetida em dois
    // processos e na fila; 3 BETs únicas só pela fila (grupos diferentes).
    const unique = Array.from({ length: 9 }, () => wagerBody(wallet, { money: brl("10.00") }));
    const repeated = wagerBody(wallet, { money: brl("10.00") });
    const repeatedMessage = wagerMessage(wallet, {
      data: { externalTransactionId: repeated.externalTransactionId, money: brl("10.00") },
    });
    const queued = Array.from({ length: 3 }, () => wagerMessage(wallet, { data: { money: brl("10.00") } }));

    const lock = await holdWalletLock(wallet.id);
    const observer = await connect("app");
    let waiters: string[] = [];
    let responses: Awaited<ReturnType<typeof submit>>[];
    try {
      const calls = [
        ...unique.map((body, i) => submit(apis[i % apis.length] as ApiClient, body)),
        submit(api1, repeated),
        submit(api2, repeated),
      ];
      await Promise.all(
        [repeatedMessage, ...queued].map((message) => sendMessage(queues.queueUrl, message.body, { groupId: newId() })),
      );
      // Prazo abaixo do lock_timeout (2 s): os 3 processos esperando a mesma wallet ao mesmo tempo.
      await waitFor(
        async () => {
          waiters = await walletLockWaiterApps(observer, lock);
          return APIS.every((app) => waiters.includes(app));
        },
        "waiters das 3 api no lock da wallet",
        WAITERS_DEADLINE_MS,
      );
      await lock.release();
      responses = await Promise.all(calls);
    } finally {
      await lock.release();
      await observer.end();
    }

    expect(new Set(waiters.filter((app) => APIS.includes(app))).size).toBe(3);
    expect(responses.map((r) => r.status)).toEqual(responses.map(() => 200));
    const [first, second] = responses.slice(-2);
    expect(second?.body.transactionId).toBe(first?.body.transactionId as string);

    // A fila termina: as 4 mensagens tratadas e apagadas.
    const viaQueue = [repeated.externalTransactionId, ...queued.map((m) => m.externalTransactionId)];
    await waitFor(
      async () => {
        const effects = await Promise.all(viaQueue.map((id) => effectsOf("provider-a", id)));
        const counts = await queueCounts(queues.queueUrl);
        return (
          effects.every((e) => e.transactions.length === 1 && e.transactions[0]?.status === "PROCESSED") &&
          counts.visible === 0 &&
          counts.inFlight === 0
        );
      },
      "as mensagens da fila processadas",
      30_000,
    );
    expect((await queueCounts(queues.dlqUrl)).visible).toBe(0);

    // Um efeito por key: 13 débitos de 10.00, nenhum a mais.
    const all = [...unique.map((b) => b.externalTransactionId), ...viaQueue];
    for (const externalId of all) {
      const effects = await effectsOf("provider-a", externalId);
      expect(effects.transactions.map((t) => t.status)).toEqual(["PROCESSED"]);
      expect(effects.entries).toEqual([{ direction: "DEBIT", amount: "10.00" }]);
    }
    const view = (await (await api3.request("GET", `/wallets/${wallet.id}`)).json()) as WalletBody;
    expect(view.balance).toEqual(brl("870.00"));
    expect(view.version).toBe(1 + all.length);
    await expectLedgerMatchesBalances();
  }, SLOW_TEST_MS);
});

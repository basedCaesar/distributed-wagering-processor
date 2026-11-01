import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DeleteMessageCommand } from "@aws-sdk/client-sqs";
import type { Client } from "pg";
import type { SqsSender } from "../../src/modules/wagering/infra/messaging/sqs-wager-queue";
import type { MessageOutcome } from "../../src/modules/wagering/infra/messaging/wager-transactions-consumer";
import {
  effectsOf,
  inboxRows,
  pollUntil,
  startTestConsumer,
  type TestConsumer,
  wagerMessage,
} from "../support/consumer";
import { connect, withClient } from "../support/db";
import { expectLedgerMatchesBalances } from "../support/db-ledger-invariant";
import { seedWallet } from "../support/db-seed";
import { createTestQueues, queueCounts, sendMessage, type TestQueues } from "../support/sqs";
import { holdWalletLock, WAITERS_DEADLINE_MS, waitForWalletLockWaiters } from "../support/wagering";

/** A reentrega espera a visibilidade vencer (1 s) e o long poll: o padrão de 5 s do bun é curto. */
const SLOW_TEST_MS = 30_000;

let queues: TestQueues;
const consumers: TestConsumer[] = [];

beforeEach(async () => {
  queues = await createTestQueues();
});

afterEach(async () => {
  for (const consumer of consumers.splice(0)) await consumer.close();
  await queues.destroy();
  await expectLedgerMatchesBalances();
});

async function consumerFor(options: Parameters<typeof startTestConsumer>[1] = {}): Promise<TestConsumer> {
  const consumer = await startTestConsumer(queues, options);
  consumers.push(consumer);
  return consumer;
}

async function wallet() {
  return withClient("app", (client) => seedWallet(client, { balance: "100.00" }));
}

/** Espera uma condição do banco (estado observável, sem `sleep`). */
async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`condição não atingida em ${timeoutMs} ms`);
}

/**
 * Sessões esperando o `transactionid` de alguma sessão que **não** é a
 * dona do lock da wallet: as duplicatas paradas na chave da inbox da
 * vencedora (o lock 1 da ordem, D19.4).
 */
async function waitForInboxWaiters(observer: Client, walletHolderPid: number, count: number): Promise<void> {
  const deadline = Date.now() + WAITERS_DEADLINE_MS;
  let seen = 0;
  while (Date.now() < deadline) {
    const { rows } = await observer.query<{ waiters: number }>(
      `SELECT count(DISTINCT waiter.pid)::int AS waiters
         FROM pg_locks waiter
         JOIN pg_locks holder
           ON holder.locktype = 'transactionid'
          AND holder.transactionid = waiter.transactionid
          AND holder.granted
        WHERE waiter.locktype = 'transactionid'
          AND NOT waiter.granted
          AND holder.pid <> $1`,
      [walletHolderPid],
    );
    seen = rows[0]?.waiters ?? 0;
    if (seen >= count) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`esperava ${count} sessões na chave da inbox, vi ${seen} em ${WAITERS_DEADLINE_MS} ms`);
}

describe("R-13-C5 R-10-09: morto depois do commit e antes do ack", () => {
  it("R-13-C5 R-10-05 R-10-09 D19.7: a reentrega vai para outra instância, que vê a inbox e não duplica", async () => {
    const w = await wallet();
    const message = wagerMessage(w);
    await sendMessage(queues.queueUrl, message.body, { groupId: w.id });

    // O "processo" A morre entre o commit e o ack: o DeleteMessage nunca chega ao SQS.
    let kill: (() => void) | undefined;
    const diesBeforeAck = (client: SqsSender): SqsSender => ({
      send(command) {
        if (command instanceof DeleteMessageCommand) {
          return new Promise((_, reject) => {
            kill = () => reject(new Error("processo morto antes do ack"));
          });
        }
        return client.send(command);
      },
    });
    const dying = await consumerFor({ wrapSqs: diesBeforeAck, policy: { visibilityTimeoutSeconds: 1 } });
    const dyingPoll = dying.pollOnce();

    // O commit aconteceu: a transação e a inbox estão gravadas, e o ack não saiu.
    await waitUntil(async () => kill !== undefined);
    expect((await effectsOf("provider-a", message.externalTransactionId)).entries).toHaveLength(1);
    expect(await inboxRows(dying.consumerName, message.messageId)).toBe(1);

    // Outra instância do mesmo consumidor recebe a reentrega quando a visibilidade vence.
    const survivor = await consumerFor({ consumerName: dying.consumerName });
    expect(await pollUntil(survivor, 1)).toEqual(["duplicate"]);
    kill?.();
    expect(await dyingPoll).toEqual(["ack_failed"]);

    const effects = await effectsOf("provider-a", message.externalTransactionId);
    expect(effects.transactions.map((t) => t.status)).toEqual(["PROCESSED"]);
    expect(effects.entries).toEqual([{ direction: "DEBIT", amount: "25.00" }]);
    expect(survivor.counted).toEqual(["inbox"]);
    expect(await queueCounts(queues.queueUrl)).toEqual({ visible: 0, inFlight: 0 });
  }, SLOW_TEST_MS);
});

describe("R-10-09 D3.7 D19.4: a mesma mensagem em 3 consumidores ao mesmo tempo", () => {
  it("R-10-09 D3.7 D19.4: um efeito; as duplicatas esperam na chave da inbox, não na wallet", async () => {
    const w = await wallet();
    const message = wagerMessage(w);
    // Três cópias em grupos diferentes: o SQS entrega as três em paralelo.
    for (const copy of ["a", "b", "c"]) {
      await sendMessage(queues.queueUrl, message.body, { groupId: `group-${copy}`, deduplicationId: `copy-${copy}` });
    }
    // Três instâncias do mesmo consumidor (mesma inbox), uma mensagem por receive.
    const first = await consumerFor({ policy: { maxMessages: 1 } });
    const name = first.consumerName;
    const instances = [
      first,
      await consumerFor({ consumerName: name, policy: { maxMessages: 1 } }),
      await consumerFor({ consumerName: name, policy: { maxMessages: 1 } }),
    ];
    const lock = await holdWalletLock(w.id);
    const observer = await connect("app");
    let outcomes: MessageOutcome[][];
    try {
      const polls = instances.map((instance) => instance.pollOnce());
      // A vencedora da inbox espera a wallet; as outras duas esperam a chave da inbox dela.
      await waitForWalletLockWaiters(observer, lock, 1);
      await waitForInboxWaiters(observer, lock.pid, 2);
      await lock.release();
      outcomes = await Promise.all(polls);
    } finally {
      await lock.release();
      await observer.end();
    }

    expect(outcomes.flat().sort()).toEqual(["duplicate", "duplicate", "processed"]);
    expect(instances.flatMap((instance) => instance.counted)).toEqual(["inbox", "inbox"]);
    expect((await effectsOf("provider-a", message.externalTransactionId)).entries).toHaveLength(1);
    expect(await inboxRows(name, message.messageId)).toBe(1);
    expect(await queueCounts(queues.queueUrl)).toEqual({ visible: 0, inFlight: 0 });
  }, SLOW_TEST_MS);
});

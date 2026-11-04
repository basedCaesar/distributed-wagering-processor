import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { Client } from "pg";
import {
  effectsOf,
  startTestConsumer,
  type TestConsumer,
  wagerMessage,
} from "../../support/consumer";
import { connect, withClient } from "../../support/db";
import { expectLedgerMatchesBalances } from "../../support/db-ledger-invariant";
import { seedWallet } from "../../support/db-seed";
import { waitForWaiterOn } from "../../support/pg-locks";
import { createTestQueues, sendMessage, type TestQueues } from "../../support/sqs";
import { holdWalletLock, transactionStartsBlockedBy, waitForWalletLockWaiters } from "../../support/wagering";

/**
 * O registro da inbox no adaptador do `UnitOfWork` (D24.3, D24.5): o horário
 * gravado é o `now()` da transação (D18.12) e a chave da inbox continua sendo
 * o primeiro lock da transação do consumidor (ordem de locks do CLAUDE.md).
 */

let queues: TestQueues;
let observer: Client;
const consumers: TestConsumer[] = [];

beforeAll(async () => {
  observer = await connect("app");
});

beforeEach(async () => {
  queues = await createTestQueues();
});

// Todo teste que move dinheiro termina com o invariante (CLAUDE.md, D11.4).
afterEach(async () => {
  for (const consumer of consumers.splice(0)) await consumer.close();
  await queues.destroy();
  await expectLedgerMatchesBalances();
});

afterAll(async () => {
  await observer.end();
});

async function consumerFor(options: Parameters<typeof startTestConsumer>[1] = {}): Promise<TestConsumer> {
  const consumer = await startTestConsumer(queues, options);
  consumers.push(consumer);
  return consumer;
}

async function wallet(balance = "100.00") {
  return withClient("app", (client) => seedWallet(client, { balance }));
}

/** Sessões bloqueadas diretamente pela sessão `holderPid`. */
async function pidsBlockedBy(holderPid: number): Promise<number[]> {
  const { rows } = await observer.query<{ pid: number }>(
    "SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
    [holderPid],
  );
  return rows.map((row) => row.pid);
}

/**
 * Espera o relógio do banco passar `marginMs` além de `since`. É estado
 * observável no próprio banco (o `clock_timestamp()`), não um `sleep`: serve
 * para que um horário lido depois disso, por qualquer relógio, não possa
 * coincidir com `since` por acaso.
 */
async function waitForDbClockPast(since: Date, marginMs: number): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query<{ past: boolean }>(
      "SELECT clock_timestamp() >= $1::timestamptz + make_interval(secs => $2::float8 / 1000) AS past",
      [since, marginMs],
    );
    if (rows[0]?.past) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`o relógio do banco não passou ${marginMs} ms além de ${since.toISOString()} em 1 s`);
}

describe("D24.5 D18.12: horário da inbox", () => {
  it("D24.5 D18.12 D19.4: received_at e processed_at da inbox são o início da transação do consumidor (xact_start), não um relógio lido depois", async () => {
    const target = await wallet();
    const gateWallet = await wallet("0.00");
    // Portão só deste teste: a transação do consumidor começa e, antes de
    // registrar a inbox, espera uma wallet que o teste segura. Assim o
    // registro acontece bem depois do início da transação, e um relógio
    // lido na hora do registro (`new Date()`) não coincide com o xact_start.
    const consumer = await consumerFor({
      wrapUow: (uow) => ({
        run: (work, options) =>
          uow.run(async (scope) => {
            await scope.wallets.lockById(gateWallet.id);
            return work(scope);
          }, options),
      }),
    });
    const message = wagerMessage(target);
    await sendMessage(queues.queueUrl, message.body, { groupId: target.id });

    const gate = await holdWalletLock(gateWallet.id);
    let outcomes: Promise<unknown> | undefined;
    let consumerTransactionStart: Date | undefined;
    try {
      outcomes = consumer.pollOnce();
      await waitForWalletLockWaiters(observer, gate, 1);
      [consumerTransactionStart] = await transactionStartsBlockedBy(observer, gate.pid);
      if (consumerTransactionStart === undefined) throw new Error("transação do consumidor não encontrada");
      await waitForDbClockPast(consumerTransactionStart, 50);
    } finally {
      await gate.release();
    }
    expect(await outcomes).toEqual(["processed"]);

    const { rows } = await observer.query<{ received_at: Date; processed_at: Date }>(
      "SELECT received_at, processed_at FROM inbox_messages WHERE consumer_name = $1 AND message_id = $2",
      [consumer.consumerName, message.messageId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.received_at.getTime()).toBe(consumerTransactionStart.getTime());
    expect(rows[0]?.processed_at.getTime()).toBe(consumerTransactionStart.getTime());
  });
});

describe("D24.5 D7: ordem de locks do consumidor", () => {
  it("D24.5 D19.4: com outra transação segurando o INSERT da mesma messageId, a 2ª entrega espera na chave da inbox (pg_locks) sem ter travado a wallet", async () => {
    const target = await wallet();
    const consumer = await consumerFor();
    const message = wagerMessage(target);
    await sendMessage(queues.queueUrl, message.body, { groupId: target.id });

    // A "1ª entrega": a mesma chave da inbox gravada e não commitada.
    const rival = await connect("app");
    let outcomes: Promise<unknown> | undefined;
    try {
      await rival.query("BEGIN");
      await rival.query(
        `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
         VALUES ($1, $2, $3, now(), now())`,
        [consumer.consumerName, message.messageId, "0".repeat(64)],
      );
      const { rows } = await rival.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const rivalPid = rows[0]?.pid as number;

      outcomes = consumer.pollOnce();
      await waitForWaiterOn(observer, rivalPid);
      const [consumerPid] = await pidsBlockedBy(rivalPid);
      expect(consumerPid).toBeDefined();

      // Só a inbox (tabela e índices) foi tocada até aqui: nem a wallet nem
      // as transações. Com o lock da wallet antes da inbox, `wallets` apareceria.
      const locked = await observer.query<{ relname: string }>(
        `SELECT DISTINCT c.relname FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
          WHERE l.pid = $1 AND l.locktype = 'relation'`,
        [consumerPid],
      );
      const relations = locked.rows.map((row) => row.relname);
      expect(relations.length).toBeGreaterThan(0);
      expect(relations.filter((name) => !name.startsWith("inbox_messages"))).toEqual([]);

      // E a linha da wallet está livre: outra sessão a trava sem esperar.
      await withClient("app", async (client) => {
        await client.query("BEGIN");
        try {
          await client.query("SELECT 1 FROM wallets WHERE id = $1 FOR UPDATE NOWAIT", [target.id]);
        } finally {
          await client.query("ROLLBACK");
        }
      });
    } finally {
      // A "1ª entrega" desiste: a 2ª grava a inbox e aplica.
      await rival.query("ROLLBACK");
      await rival.end();
    }
    expect(await outcomes).toEqual(["processed"]);

    const effects = await effectsOf("provider-a", message.externalTransactionId);
    expect(effects.transactions.map((t) => t.status)).toEqual(["PROCESSED"]);
    expect(effects.entries).toEqual([{ direction: "DEBIT", amount: "25.00" }]);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  effectsOf,
  inboxRows,
  messageAttempts,
  pollUntil,
  startTestConsumer,
  type TestConsumer,
  wagerMessage,
} from "../../support/consumer";
import { connect, withClient } from "../../support/db";
import { expectLedgerMatchesBalances } from "../../support/db-ledger-invariant";
import { seedWallet } from "../../support/db-seed";
import { createTestQueues, sendMessage, type TestQueues } from "../../support/sqs";

/** O `lock_timeout` e o long poll do consumidor não cabem nos 5 s padrão do bun. */
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

async function walletState(walletId: string) {
  return withClient("app", async (client) => {
    const wallet = await client.query<{ balance: string; version: number }>(
      "SELECT balance::text AS balance, version FROM wallets WHERE id = $1",
      [walletId],
    );
    const ledger = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = $1",
      [walletId],
    );
    const outbox = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM outbox_messages WHERE ordering_key = $1",
      [walletId],
    );
    return { ...wallet.rows[0], ledgerEntries: ledger.rows[0]?.n, outboxEvents: outbox.rows[0]?.n };
  });
}

/**
 * Constraint trigger diferido, criado pelo papel dono só para este teste
 * (D20.7): no COMMIT, depois de todos os INSERTs, falha se a transação
 * gravou um evento da wallet `walletId`. Os outros testes não são afetados.
 * Devolve a função que o apaga.
 */
async function failCommitFor(walletId: string): Promise<() => Promise<void>> {
  const suffix = walletId.replaceAll("-", "");
  const fn = `test_fail_commit_${suffix}`;
  const owner = await connect("owner");
  try {
    await owner.query(`
      CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.ordering_key = '${walletId}' THEN
          RAISE EXCEPTION 'falha forçada no COMMIT (R-13-I2)';
        END IF;
        RETURN NEW;
      END $$`);
    await owner.query(`
      CREATE CONSTRAINT TRIGGER ${fn} AFTER INSERT ON outbox_messages
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
  } finally {
    await owner.end();
  }
  return async () => {
    const cleanup = await connect("owner");
    try {
      await cleanup.query(`DROP TRIGGER IF EXISTS ${fn} ON outbox_messages`);
      await cleanup.query(`DROP FUNCTION IF EXISTS ${fn}()`);
    } finally {
      await cleanup.end();
    }
  };
}

describe("R-13-I2 R-11-01 D20.7: atomicidade entre wallet, ledger, inbox e outbox", () => {
  it("R-13-I2 R-11-01 D20.7: falha no COMMIT depois de gravar transação, ledger, saldo, outbox e inbox → nada fica e não há ack; sem a falha, tudo fica", async () => {
    const wallet = await withClient("app", (client) => seedWallet(client, { balance: "100.00" }));
    const message = wagerMessage(wallet);
    await sendMessage(queues.queueUrl, message.body, { groupId: wallet.id });
    const consumer = await startTestConsumer(queues);
    consumers.push(consumer);
    const before = await walletState(wallet.id);

    const dropTrigger = await failCommitFor(wallet.id);
    try {
      // A BET passa pelas regras, grava tudo e cai no COMMIT: erro interno, retry contado.
      expect(await pollUntil(consumer, 1)).toEqual(["retry_scheduled"]);
    } finally {
      await dropTrigger();
    }

    expect(await walletState(wallet.id)).toEqual(before);
    expect((await effectsOf("provider-a", message.externalTransactionId)).transactions).toEqual([]);
    expect(await inboxRows(consumer.consumerName, message.messageId)).toBe(0);
    expect(await messageAttempts(consumer.consumerName, message.messageId)).toEqual({
      attempts: 1,
      last_error_code: "INTERNAL_ERROR",
    });

    // Sem o trigger, a mesma mensagem (não houve ack) grava tudo: a falha era só o COMMIT.
    expect(await pollUntil(consumer, 1)).toEqual(["processed"]);
    const after = await walletState(wallet.id);
    expect(after).toMatchObject({ balance: "75.00", version: (before.version ?? 0) + 1 });
    expect(after.ledgerEntries).toBe((before.ledgerEntries ?? 0) + 1);
    expect(after.outboxEvents).toBe((before.outboxEvents ?? 0) + 2);
    expect(await inboxRows(consumer.consumerName, message.messageId)).toBe(1);
  }, SLOW_TEST_MS);
});

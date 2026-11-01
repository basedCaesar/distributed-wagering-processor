import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createServer } from "node:net";
import { ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { Test } from "@nestjs/testing";
import { ConsumerAppModule } from "../../../src/app/consumer.module";
import type { UnitOfWork } from "../../../src/modules/wagering/application/ports";
import type { SqsSender } from "../../../src/modules/wagering/infra/messaging/sqs-wager-queue";
import { WagerTransactionsConsumer } from "../../../src/modules/wagering/infra/messaging/wager-transactions-consumer";
import { queueUrlOf } from "../../../src/shared/aws/sqs-client";
import { startTestApi, type TestApi } from "../../support/api";
import {
  effectsOf,
  inboxRows,
  messageAttempts,
  pollUntil,
  startTestConsumer,
  type TestConsumer,
  wagerMessage,
} from "../../support/consumer";
import { connect, credentialsFor, withClient } from "../../support/db";
import { expectLedgerMatchesBalances } from "../../support/db-ledger-invariant";
import { seedWallet } from "../../support/db-seed";
import {
  createTestQueues,
  ORIGIN_ATTRIBUTES,
  plainAttributes,
  queueCounts,
  receiveMessages,
  sendMessage,
  type TestQueues,
  testSqsClient,
} from "../../support/sqs";
import { parkPendings } from "../../support/worker";
import {
  brl,
  createWallet,
  holdWalletLock,
  submit,
  waitForWalletLockWaiters,
  wagerBody,
} from "../../support/wagering";

/**
 * Prazo dos testes que esperam o `lock_timeout` de 2 s (D5) por tentativa,
 * a visibilidade do backoff ou a subida da API: o padrão de 5 s do bun não
 * cabe.
 */
const SLOW_TEST_MS = 30_000;

let queues: TestQueues;
const consumers: TestConsumer[] = [];
const pendings: string[] = [];

beforeEach(async () => {
  queues = await createTestQueues();
});

// Todo teste que move dinheiro termina com o invariante (CLAUDE.md, D11.4).
afterEach(async () => {
  for (const consumer of consumers.splice(0)) await consumer.close();
  await withClient("app", (client) => parkPendings(client, pendings));
  await queues.destroy();
  await expectLedgerMatchesBalances();
});

async function consumerFor(options: Parameters<typeof startTestConsumer>[1] = {}): Promise<TestConsumer> {
  const consumer = await startTestConsumer(queues, options);
  consumers.push(consumer);
  return consumer;
}

async function wallet(balance = "100.00") {
  return withClient("app", (client) => seedWallet(client, { balance }));
}

async function balanceOf(walletId: string): Promise<string> {
  return withClient("app", async (client) => {
    const { rows } = await client.query<{ balance: string }>(
      "SELECT balance::text AS balance FROM wallets WHERE id = $1",
      [walletId],
    );
    return rows[0]?.balance as string;
  });
}

/** A fila principal não tem mais nada, nem visível nem em voo. */
async function expectQueueEmpty(url: string): Promise<void> {
  expect(await queueCounts(url)).toEqual({ visible: 0, inFlight: 0 });
}

/** A mensagem do §10 (L549–567), texto literal. */
const SECTION_10_BODY = `{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}`;

describe("R-10-02 D8.1: a mensagem do §10", () => {
  it("R-10-02 D8.1 D19.8: o corpo literal, só com MessageGroupId, é processado; um único débito da transação", async () => {
    // Ids fixos do §10: a primeira rodada aplica, as seguintes caem no replay (D19.8).
    await withClient("app", async (client) => {
      const { rows } = await client.query("SELECT 1 FROM wallets WHERE id = $1", [
        "0192f291-27dd-7d3f-8071-5f8685deef37",
      ]);
      if (rows.length === 0) {
        await seedWallet(client, {
          id: "0192f291-27dd-7d3f-8071-5f8685deef37",
          playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
          balance: "1000.00",
        });
      }
    });
    await sendMessage(queues.queueUrl, SECTION_10_BODY, { groupId: "0192f291-27dd-7d3f-8071-5f8685deef37" });
    const consumer = await consumerFor();

    expect(await pollUntil(consumer, 1)).toEqual(["processed"]);

    const effects = await effectsOf("provider-a", "transaction-123");
    expect(effects.transactions.map((t) => t.status)).toEqual(["PROCESSED"]);
    expect(effects.entries).toEqual([{ direction: "DEBIT", amount: "25.00" }]);
    expect(await inboxRows(consumer.consumerName, "msg-123")).toBe(1);
    await expectQueueEmpty(queues.queueUrl);
    await expectQueueEmpty(queues.dlqUrl);
  });
});

describe("R-10-04 R-10-09 R-13-I3 D3.7 D3.8: inbox e reentrega", () => {
  it("R-10-04 R-13-I3 D3.7: a mesma mensagem duas vezes → um efeito; a segunda é duplicata da inbox", async () => {
    const w = await wallet();
    const message = wagerMessage(w);
    await sendMessage(queues.queueUrl, message.body, { groupId: w.id, deduplicationId: "copy-1" });
    await sendMessage(queues.queueUrl, message.body, { groupId: w.id, deduplicationId: "copy-2" });
    const consumer = await consumerFor();

    expect(await pollUntil(consumer, 2)).toEqual(["processed", "duplicate"]);

    expect((await effectsOf("provider-a", message.externalTransactionId)).entries).toHaveLength(1);
    expect(await balanceOf(w.id)).toBe("75.00");
    expect(consumer.counted).toEqual(["inbox"]);
    await expectQueueEmpty(queues.queueUrl);
    await expectQueueEmpty(queues.dlqUrl);
  });

  it("D3.8: mesmo messageId com outro occurredAt → duplicata, sem efeito novo", async () => {
    const w = await wallet();
    const first = wagerMessage(w);
    const resent = wagerMessage(w, {
      messageId: first.messageId,
      occurredAt: "2026-07-29T15:05:00.000Z",
      data: { externalTransactionId: first.externalTransactionId },
    });
    await sendMessage(queues.queueUrl, first.body, { groupId: w.id });
    await sendMessage(queues.queueUrl, resent.body, { groupId: w.id });
    const consumer = await consumerFor();

    expect(await pollUntil(consumer, 2)).toEqual(["processed", "duplicate"]);
    expect(await balanceOf(w.id)).toBe("75.00");
  });

  it("D3.8 D19.4: mesmo messageId com outro payload → DLQ (permanente), intacta, sem efeito", async () => {
    const w = await wallet();
    const first = wagerMessage(w);
    const conflicting = wagerMessage(w, {
      messageId: first.messageId,
      data: { externalTransactionId: first.externalTransactionId, money: { amount: "30.00", currency: "BRL" } },
    });
    await sendMessage(queues.queueUrl, first.body, { groupId: w.id });
    await sendMessage(queues.queueUrl, conflicting.body, { groupId: w.id, attributes: ORIGIN_ATTRIBUTES });
    const consumer = await consumerFor();

    expect(await pollUntil(consumer, 2)).toEqual(["processed", "dead_lettered"]);

    const [copy] = await receiveMessages(queues.dlqUrl, 1);
    expect(copy?.Body).toBe(conflicting.body);
    expect(plainAttributes(copy?.MessageAttributes)).toEqual(plainAttributes(ORIGIN_ATTRIBUTES));
    expect(await balanceOf(w.id)).toBe("75.00");
    await expectQueueEmpty(queues.queueUrl);
  });

  it("D3.8: messageId diferente com a mesma key → passa pela inbox e o use case devolve replay; um efeito", async () => {
    const w = await wallet();
    const first = wagerMessage(w);
    const again = wagerMessage(w, { data: { externalTransactionId: first.externalTransactionId } });
    await sendMessage(queues.queueUrl, first.body, { groupId: w.id });
    await sendMessage(queues.queueUrl, again.body, { groupId: w.id });
    const consumer = await consumerFor();

    expect(await pollUntil(consumer, 2)).toEqual(["processed", "processed"]);

    expect((await effectsOf("provider-a", first.externalTransactionId)).entries).toHaveLength(1);
    expect(await inboxRows(consumer.consumerName, again.messageId)).toBe(1);
    expect(consumer.counted).toEqual(["lock"]);
    expect(await balanceOf(w.id)).toBe("75.00");
  });
});

describe("R-10-03 D3.3: o mesmo use case do HTTP", () => {
  let api: TestApi | undefined;

  afterAll(async () => {
    await api?.close();
  });

  it("R-10-03 D3.3: transação enviada pelo HTTP e depois pela fila → replay, um efeito", async () => {
    api = await startTestApi();
    const w = await createWallet(api, brl("100.00"));
    const body = wagerBody(w);
    expect((await submit(api, body)).status).toBe(200);

    const message = wagerMessage(w, { data: { externalTransactionId: body.externalTransactionId } });
    await sendMessage(queues.queueUrl, message.body, { groupId: w.id });
    const consumer = await consumerFor();

    expect(await pollUntil(consumer, 1)).toEqual(["processed"]);
    expect(consumer.counted).toEqual(["lock"]);
    expect((await effectsOf("provider-a", body.externalTransactionId)).entries).toHaveLength(1);
    expect(await balanceOf(w.id)).toBe("75.00");
  }, SLOW_TEST_MS);
});

describe("R-10-06 D8.2: negócio → ack", () => {
  it("R-10-06 D8.2: REJECTED (sem saldo) → ack, gravada, fora da DLQ", async () => {
    const w = await wallet("10.00");
    const message = wagerMessage(w);
    await sendMessage(queues.queueUrl, message.body, { groupId: w.id });
    const consumer = await consumerFor();

    expect(await pollUntil(consumer, 1)).toEqual(["processed"]);

    const effects = await effectsOf("provider-a", message.externalTransactionId);
    expect(effects.transactions).toMatchObject([{ status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS" }]);
    await expectQueueEmpty(queues.queueUrl);
    await expectQueueEmpty(queues.dlqUrl);
  });

  it("R-10-06 D8.2: PENDING_REFERENCE (REFUND antes da BET) → ack, gravada, fora da DLQ", async () => {
    const w = await wallet();
    const message = wagerMessage(w, {
      data: { kind: "REFUND", referenceExternalTransactionId: `tx-${Bun.randomUUIDv7()}` },
    });
    await sendMessage(queues.queueUrl, message.body, { groupId: w.id });
    const consumer = await consumerFor();

    expect(await pollUntil(consumer, 1)).toEqual(["processed"]);

    const effects = await effectsOf("provider-a", message.externalTransactionId);
    expect(effects.transactions.map((t) => t.status)).toEqual(["PENDING_REFERENCE"]);
    pendings.push(...effects.transactions.map((t) => t.id));
    await expectQueueEmpty(queues.queueUrl);
    await expectQueueEmpty(queues.dlqUrl);
  });
});

describe("R-10-06 D8.2 D19.1: permanente → DLQ na hora, intacta", () => {
  async function expectDeadLetteredIntact(body: string): Promise<void> {
    await sendMessage(queues.queueUrl, body, { groupId: "group-permanent", attributes: ORIGIN_ATTRIBUTES });
    const consumer = await consumerFor();

    expect(await pollUntil(consumer, 1)).toEqual(["dead_lettered"]);

    const [copy] = await receiveMessages(queues.dlqUrl, 1);
    expect(copy?.Body).toBe(body);
    expect(plainAttributes(copy?.MessageAttributes)).toEqual(plainAttributes(ORIGIN_ATTRIBUTES));
    expect(copy?.Attributes?.MessageGroupId).toBe("group-permanent");
    await expectQueueEmpty(queues.queueUrl);
  }

  it("R-10-06 D8.2: JSON quebrado → DLQ", async () => {
    await expectDeadLetteredIntact(`{ "messageId": "msg-${Bun.randomUUIDv7()}", `);
  });

  it("R-10-06 D8.2 D19.5: type desconhecido → DLQ", async () => {
    const message = wagerMessage(await wallet());
    await expectDeadLetteredIntact(message.body.replace("WagerTransactionRequested", "WagerTransactionCancelled"));
    expect(await messageAttempts(consumers[0]?.consumerName as string, message.messageId)).toBeUndefined();
  });

  it("R-10-06 D8.2 R-06-38: kind OPENING → DLQ, nada gravado", async () => {
    const message = wagerMessage(await wallet(), { data: { kind: "OPENING" } });
    await expectDeadLetteredIntact(message.body);
    expect((await effectsOf("provider-a", message.externalTransactionId)).transactions).toEqual([]);
  });

  it("R-10-06 D5 D8.2: wallet inexistente → DLQ, nada gravado (nem inbox)", async () => {
    const message = wagerMessage({ id: Bun.randomUUIDv7(), playerId: "player-ghost" });
    await expectDeadLetteredIntact(message.body);
    expect((await effectsOf("provider-a", message.externalTransactionId)).transactions).toEqual([]);
    expect(await inboxRows(consumers[0]?.consumerName as string, message.messageId)).toBe(0);
  });

  it("R-10-06 D19.1: mesma key com outro payload (IDEMPOTENCY_KEY_CONFLICT) → DLQ", async () => {
    const w = await wallet();
    const first = wagerMessage(w);
    const conflicting = wagerMessage(w, {
      data: { externalTransactionId: first.externalTransactionId, money: { amount: "30.00", currency: "BRL" } },
    });
    await sendMessage(queues.queueUrl, first.body, { groupId: w.id });
    await sendMessage(queues.queueUrl, conflicting.body, { groupId: w.id });
    const consumer = await consumerFor();

    expect(await pollUntil(consumer, 2)).toEqual(["processed", "dead_lettered"]);
    expect((await receiveMessages(queues.dlqUrl, 1))[0]?.Body).toBe(conflicting.body);
    expect(await balanceOf(w.id)).toBe("75.00");
  });

  it("R-10-06 D19.1: id externo repetido com outra key (EXTERNAL_ID_CONFLICT) → DLQ", async () => {
    const w = await wallet();
    const first = wagerMessage(w);
    const otherKey = wagerMessage(w, {
      data: { externalTransactionId: first.externalTransactionId, idempotencyKey: `other:${first.externalTransactionId}` },
    });
    await sendMessage(queues.queueUrl, first.body, { groupId: w.id });
    await sendMessage(queues.queueUrl, otherKey.body, { groupId: w.id });
    const consumer = await consumerFor();

    expect(await pollUntil(consumer, 2)).toEqual(["processed", "dead_lettered"]);
    expect((await receiveMessages(queues.dlqUrl, 1))[0]?.Body).toBe(otherKey.body);
    expect(await balanceOf(w.id)).toBe("75.00");
  });
});

describe("R-10-07 R-13-I5 D8.2 D8.3: transitório → retry com backoff, depois DLQ", () => {
  it("R-10-07 R-13-I5 D8.3: wallet travada (lock_timeout) → tentativas em message_attempts e DLQ no limite, nada gravado", async () => {
    const w = await wallet();
    const message = wagerMessage(w);
    await sendMessage(queues.queueUrl, message.body, { groupId: w.id, attributes: ORIGIN_ATTRIBUTES });
    const consumer = await consumerFor({ policy: { maxAttempts: 3 } });
    const lock = await holdWalletLock(w.id);
    try {
      expect(await pollUntil(consumer, 1)).toEqual(["retry_scheduled"]);
      expect(await messageAttempts(consumer.consumerName, message.messageId)).toEqual({
        attempts: 1,
        last_error_code: "TEMPORARILY_UNAVAILABLE",
      });
      expect(await pollUntil(consumer, 1)).toEqual(["retry_scheduled"]);
      expect(await pollUntil(consumer, 1)).toEqual(["dead_lettered"]);
    } finally {
      await lock.release();
    }

    expect((await messageAttempts(consumer.consumerName, message.messageId))?.attempts).toBe(3);
    const [copy] = await receiveMessages(queues.dlqUrl, 1);
    expect(copy?.Body).toBe(message.body);
    expect(plainAttributes(copy?.MessageAttributes)).toEqual(plainAttributes(ORIGIN_ATTRIBUTES));
    expect((await effectsOf("provider-a", message.externalTransactionId)).transactions).toEqual([]);
    expect(await inboxRows(consumer.consumerName, message.messageId)).toBe(0);
    await expectQueueEmpty(queues.queueUrl);
  }, SLOW_TEST_MS);

  it("D8.2: o retry devolve a mensagem com visibilidade de 2ⁿ s (2 s na 1ª), não com os 120 s do receive", async () => {
    const w = await wallet();
    const message = wagerMessage(w);
    await sendMessage(queues.queueUrl, message.body, { groupId: w.id });
    const consumer = await consumerFor({ policy: { backoffMaxSeconds: 300 } });
    const lock = await holdWalletLock(w.id);
    try {
      expect(await pollUntil(consumer, 1)).toEqual(["retry_scheduled"]);
    } finally {
      await lock.release();
    }
    expect(await queueCounts(queues.queueUrl)).toEqual({ visible: 0, inFlight: 1 });

    // Volta a ficar visível em ~2 s; o long poll pega dentro de 6 s (os 120 s nunca chegariam).
    const [redelivered] = await receiveMessages(queues.queueUrl, 1, 6000);
    expect(redelivered?.Body).toBe(message.body);
    expect(redelivered?.Attributes?.ApproximateReceiveCount).toBe("2");
  }, SLOW_TEST_MS);

  it("R-13-I5 D19.3: Postgres inalcançável → retries pelo SQS e DLQ pelo redrive, intacta", async () => {
    await queues.destroy();
    queues = await createTestQueues({ maxReceiveCount: 2 });
    const message = wagerMessage({ id: Bun.randomUUIDv7(), playerId: "player-unreachable" });
    await sendMessage(queues.queueUrl, message.body, { groupId: "group-down", attributes: ORIGIN_ATTRIBUTES });
    const credentials = { ...(await credentialsFor("app")), host: "127.0.0.1", port: await closedPort() };
    const consumer = await consumerFor({ credentials });

    expect(await pollUntil(consumer, 1)).toEqual(["retry_scheduled"]);
    expect(await pollUntil(consumer, 1)).toEqual(["retry_scheduled"]);
    // Terceiro receive: o redrive (maxReceiveCount 2) move a mensagem para a DLQ.
    expect(await consumer.pollOnce()).toEqual([]);

    const [copy] = await receiveMessages(queues.dlqUrl, 1);
    expect(copy?.Body).toBe(message.body);
    expect(plainAttributes(copy?.MessageAttributes)).toEqual(plainAttributes(ORIGIN_ATTRIBUTES));
    expect(await messageAttempts(consumer.consumerName, message.messageId)).toBeUndefined();
    await expectQueueEmpty(queues.queueUrl);
  }, SLOW_TEST_MS);

  it("R-10-05 D19.2: falha forçada no commit → sem ack, nada gravado (nem inbox), tentativa contada", async () => {
    const w = await wallet();
    const message = wagerMessage(w);
    await sendMessage(queues.queueUrl, message.body, { groupId: w.id });
    const failingCommit = (uow: UnitOfWork): UnitOfWork => ({
      run: (work, options) =>
        uow.run(async (scope) => {
          await work(scope);
          throw new Error("commit forçado a falhar");
        }, options),
    });
    const consumer = await consumerFor({ wrapUow: failingCommit });

    expect(await pollUntil(consumer, 1)).toEqual(["retry_scheduled"]);

    expect((await effectsOf("provider-a", message.externalTransactionId)).transactions).toEqual([]);
    expect(await inboxRows(consumer.consumerName, message.messageId)).toBe(0);
    expect(await messageAttempts(consumer.consumerName, message.messageId)).toEqual({
      attempts: 1,
      last_error_code: "INTERNAL_ERROR",
    });
    expect(await balanceOf(w.id)).toBe("100.00");
    // A mensagem continua na fila (backoff 0 nos testes): não houve ack.
    expect((await receiveMessages(queues.queueUrl, 1))[0]?.Body).toBe(message.body);
  });
});

describe("R-10-08 D8.5: SIGTERM (stop)", () => {
  it("R-10-08 D8.5 D19.7: stop no meio do lote termina a mensagem em andamento e devolve as não iniciadas", async () => {
    const locked = await wallet();
    const other = await wallet();
    const inFlight = wagerMessage(locked);
    const notStarted = wagerMessage(other);
    // Mesmo grupo: as duas no mesmo lote, em sequência (D19.6).
    await sendMessage(queues.queueUrl, inFlight.body, { groupId: "group-stop" });
    await sendMessage(queues.queueUrl, notStarted.body, { groupId: "group-stop" });
    const consumer = await consumerFor({ policy: { maxMessages: 10 } });
    const lock = await holdWalletLock(locked.id);
    const observer = await connect("app");
    try {
      consumer.consumer.start();
      await waitForWalletLockWaiters(observer, lock, 1);
      const stopping = consumer.consumer.stop();
      await lock.release();
      await stopping;
    } finally {
      await lock.release();
      await observer.end();
    }

    expect(await balanceOf(locked.id)).toBe("75.00");
    expect(await balanceOf(other.id)).toBe("100.00");
    const [returned] = await receiveMessages(queues.queueUrl, 1, 3000);
    expect(returned?.Body).toBe(notStarted.body);
    await expectQueueEmpty(queues.dlqUrl);
  }, SLOW_TEST_MS);

  it("R-10-08 D19.9: stop durante um long poll vazio não deixa presa a mensagem que chega nesse intervalo", async () => {
    // Sinaliza quando o ReceiveMessage saiu para o SQS: o long poll está aberto.
    let polling: (() => void) | undefined;
    const pollOpen = new Promise<void>((resolve) => {
      polling = resolve;
    });
    const signalsReceive = (client: SqsSender): SqsSender => ({
      send(command) {
        if (command instanceof ReceiveMessageCommand) polling?.();
        return client.send(command);
      },
    });
    const consumer = await consumerFor({ wrapSqs: signalsReceive, policy: { waitTimeSeconds: 5 } });
    const message = wagerMessage(await wallet());

    consumer.consumer.start();
    await pollOpen;
    // Uma ida e volta ao LocalStack por outra conexão: quando ela volta, o
    // ReceiveMessage que saiu antes já está aberto no servidor.
    await queueCounts(queues.queueUrl);
    await queueCounts(queues.queueUrl);
    const stopping = consumer.consumer.stop();
    await sendMessage(queues.queueUrl, message.body, { groupId: "group-stop-poll" });
    await stopping;

    // Devolvida com visibilidade 0, sem processar: outro receive a pega na hora (não em 120 s).
    const [returned] = await receiveMessages(queues.queueUrl, 1, 3000);
    expect(returned?.Body).toBe(message.body);
    expect((await effectsOf("provider-a", message.externalTransactionId)).transactions).toEqual([]);
  }, SLOW_TEST_MS);
});

describe("D7.4 D8.5: o processo consumer (Nest)", () => {
  it("D7.4: o ConsumerAppModule consome a wager-transactions.fifo configurada e para no shutdown", async () => {
    const w = await wallet();
    const message = wagerMessage(w);
    const client = testSqsClient();
    const queueUrl = await queueUrlOf(client, process.env.QUEUE_WAGER_TRANSACTIONS as string);
    await sendMessage(queueUrl, message.body, { groupId: w.id });
    const moduleRef = await Test.createTestingModule({ imports: [ConsumerAppModule] }).compile();
    const app = await moduleRef.init();
    try {
      app.get(WagerTransactionsConsumer).start();
      const deadline = Date.now() + 10_000;
      while ((await effectsOf("provider-a", message.externalTransactionId)).entries.length === 0) {
        if (Date.now() > deadline) throw new Error("o consumer não processou a mensagem em 10 s");
        await new Promise((resolve) => setImmediate(resolve));
      }
    } finally {
      await app.close();
      client.destroy();
    }
    expect(await balanceOf(w.id)).toBe("75.00");
  }, SLOW_TEST_MS);
});

/** Porta reservada e liberada na hora: nada escuta nela (conexão recusada). */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("endereço TCP inesperado");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

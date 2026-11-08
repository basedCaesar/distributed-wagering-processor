import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  ACCOUNTING_CONSUMER_NAME,
  accountingAttempts,
  accountingInboxRows,
  balanceChanged,
  journalOf,
  pair,
  playerAccountBalance,
  receivedHalves,
  startTestAccountingConsumer,
  type TestAccountingConsumer,
  transactionProcessed,
} from "../../support/accounting";
import { pollUntil } from "../../support/consumer";
import { connect, newId } from "../../support/db";
import {
  createTestQueues,
  ORIGIN_ATTRIBUTES,
  plainAttributes,
  queueCounts,
  receiveMessages,
  sendMessage,
  type TestQueues,
} from "../../support/sqs";

let queues: TestQueues;
const consumers: TestAccountingConsumer[] = [];

beforeEach(async () => {
  queues = await createTestQueues();
});

afterEach(async () => {
  for (const consumer of consumers.splice(0)) await consumer.close();
  await queues.destroy();
});

async function consumerFor(options: { consumerName?: string } = {}): Promise<TestAccountingConsumer> {
  const consumer = await startTestAccountingConsumer(queues, options);
  consumers.push(consumer);
  return consumer;
}

async function send(walletId: string, ...events: { body: string }[]): Promise<void> {
  for (const event of events) await sendMessage(queues.queueUrl, event.body, { groupId: walletId });
}

const linesOf = async (walletId: string) =>
  (await journalOf(walletId)).map((entry) => [entry.kind, entry.wallet_version, entry.lines.map((l) => [l.account, l.direction, l.amount])]);

describe("§6.4 D27.1 D27.2: as duas metades viram um lançamento de partidas dobradas", () => {
  it("§6.4 D27.1 D27.2: BET de 25.00 (Processed + BalanceChanged) → débito PLAYER_WALLET, crédito HOUSE_WAGERS_RECEIVED", async () => {
    const walletId = newId();
    const bet = pair({ walletId, kind: "BET", direction: "DEBIT", amount: "25.00", before: "100.00", after: "75.00", walletVersion: 2 });
    await send(walletId, bet.processed, bet.balance);
    const consumer = await consumerFor();

    expect(await pollUntil(consumer, 2)).toEqual(["processed", "processed"]);

    const [entry] = await journalOf(walletId);
    expect(entry).toMatchObject({
      transaction_id: bet.transactionId,
      kind: "BET",
      wallet_version: 2,
      balance_event_id: bet.balance.eventId,
      processed_event_id: bet.processed.eventId,
    });
    expect(entry?.lines).toEqual([
      { account: "PLAYER_WALLET", direction: "DEBIT", amount: "25.00", currency: "BRL" },
      { account: "HOUSE_WAGERS_RECEIVED", direction: "CREDIT", amount: "25.00", currency: "BRL" },
    ]);
    expect(await playerAccountBalance(walletId)).toBe("-25.00");
    expect(consumer.posted()).toBe(1);
  });

  it("D27.1 D27.2: OPENING, WIN, REFUND e os dois ROLLBACKs → cada um na conta da casa certa; saldo da conta = saldo da wallet", async () => {
    const walletId = newId();
    const events = [
      pair({ walletId, kind: "OPENING", direction: "CREDIT", amount: "100.00", before: "0.00", after: "100.00", walletVersion: 1 }),
      pair({ walletId, kind: "BET", direction: "DEBIT", amount: "30.00", before: "100.00", after: "70.00", walletVersion: 2 }),
      pair({ walletId, kind: "REFUND", direction: "CREDIT", amount: "30.00", before: "70.00", after: "100.00", walletVersion: 3 }),
      pair({ walletId, kind: "WIN", direction: "CREDIT", amount: "15.00", before: "100.00", after: "115.00", walletVersion: 4 }),
      pair({ walletId, kind: "ROLLBACK", direction: "DEBIT", amount: "15.00", before: "115.00", after: "100.00", walletVersion: 5 }),
      pair({ walletId, kind: "BET", direction: "DEBIT", amount: "10.00", before: "100.00", after: "90.00", walletVersion: 6 }),
      pair({ walletId, kind: "ROLLBACK", direction: "CREDIT", amount: "10.00", before: "90.00", after: "100.00", walletVersion: 7 }),
    ];
    await send(walletId, ...events.flatMap((event) => [event.processed, event.balance]));
    const consumer = await consumerFor();

    await pollUntil(consumer, events.length * 2, 20);

    expect(await linesOf(walletId)).toEqual([
      ["OPENING", 1, [["HOUSE_OPENING_FUNDS", "DEBIT", "100.00"], ["PLAYER_WALLET", "CREDIT", "100.00"]]],
      ["BET", 2, [["PLAYER_WALLET", "DEBIT", "30.00"], ["HOUSE_WAGERS_RECEIVED", "CREDIT", "30.00"]]],
      ["REFUND", 3, [["HOUSE_REFUNDS", "DEBIT", "30.00"], ["PLAYER_WALLET", "CREDIT", "30.00"]]],
      ["WIN", 4, [["HOUSE_PAYOUTS", "DEBIT", "15.00"], ["PLAYER_WALLET", "CREDIT", "15.00"]]],
      ["ROLLBACK", 5, [["PLAYER_WALLET", "DEBIT", "15.00"], ["HOUSE_ROLLBACKS", "CREDIT", "15.00"]]],
      ["BET", 6, [["PLAYER_WALLET", "DEBIT", "10.00"], ["HOUSE_WAGERS_RECEIVED", "CREDIT", "10.00"]]],
      ["ROLLBACK", 7, [["HOUSE_ROLLBACKS", "DEBIT", "10.00"], ["PLAYER_WALLET", "CREDIT", "10.00"]]],
    ]);
    expect(await playerAccountBalance(walletId)).toBe("100.00");
  });

  it("D27.1 D27.4: a BalanceChanged antes da Processed → o mesmo lançamento; a primeira metade espera sem lançar", async () => {
    const walletId = newId();
    const bet = pair({ walletId, kind: "BET", direction: "DEBIT", amount: "25.00", before: "100.00", after: "75.00", walletVersion: 2 });
    await send(walletId, bet.balance);
    const consumer = await consumerFor();

    expect(await pollUntil(consumer, 1)).toEqual(["processed"]);
    expect(await journalOf(walletId)).toEqual([]);
    expect(await receivedHalves(bet.transactionId)).toEqual(["WalletBalanceChanged"]);

    await send(walletId, bet.processed);
    expect(await pollUntil(consumer, 1)).toEqual(["processed"]);
    expect((await linesOf(walletId))[0]).toEqual([
      "BET",
      2,
      [["PLAYER_WALLET", "DEBIT", "25.00"], ["HOUSE_WAGERS_RECEIVED", "CREDIT", "25.00"]],
    ]);
  });

  it("D27.4: versões fora de ordem (3 chega antes da 2) → as duas lançadas; o saldo da conta não depende da ordem", async () => {
    const walletId = newId();
    const v2 = pair({ walletId, kind: "BET", direction: "DEBIT", amount: "25.00", before: "100.00", after: "75.00", walletVersion: 2 });
    const v3 = pair({ walletId, kind: "WIN", direction: "CREDIT", amount: "40.00", before: "75.00", after: "115.00", walletVersion: 3 });
    await send(walletId, v3.processed, v3.balance, v2.balance, v2.processed);
    const consumer = await consumerFor();

    await pollUntil(consumer, 4);

    expect((await journalOf(walletId)).map((entry) => entry.wallet_version)).toEqual([2, 3]);
    expect(await playerAccountBalance(walletId)).toBe("15.00");
  });

  it("D27.1: LOSS (Processed sem walletVersion) e WalletOpened → ack sem efeito no banco", async () => {
    const walletId = newId();
    const transactionId = newId();
    const loss = transactionProcessed({ walletId, transactionId, kind: "LOSS", amount: "0.00", after: "75.00" });
    const opened = JSON.stringify({
      eventId: newId(),
      eventType: "WalletOpened",
      aggregateId: walletId,
      correlationId: "corr-opened",
      occurredAt: new Date().toISOString(),
      version: 1,
      data: { walletId, playerId: "player-1", currency: "BRL", initialBalance: { amount: "0.00", currency: "BRL" }, walletVersion: 1 },
    });
    await send(walletId, loss, { body: opened });
    const consumer = await consumerFor();

    expect(await pollUntil(consumer, 2)).toEqual(["processed", "processed"]);
    expect(await receivedHalves(transactionId)).toEqual([]);
    expect(await accountingInboxRows(consumer.consumerName, loss.eventId)).toBe(0);
    expect(await queueCounts(queues.queueUrl)).toEqual({ visible: 0, inFlight: 0 });
  });
});

describe("R-11-03 D9.7 D27.5: publicação duplicada continua segura para o accounting", () => {
  it("R-11-03 D27.5: a mesma metade entregue duas vezes (fora da janela de deduplicação) → aplica uma vez", async () => {
    const walletId = newId();
    const bet = pair({ walletId, kind: "BET", direction: "DEBIT", amount: "25.00", before: "100.00", after: "75.00", walletVersion: 2 });
    await sendMessage(queues.queueUrl, bet.processed.body, { groupId: walletId });
    await sendMessage(queues.queueUrl, bet.balance.body, { groupId: walletId, deduplicationId: "copy-1" });
    await sendMessage(queues.queueUrl, bet.balance.body, { groupId: walletId, deduplicationId: "copy-2" });
    await sendMessage(queues.queueUrl, bet.processed.body, { groupId: walletId, deduplicationId: "copy-3" });
    const consumer = await consumerFor();

    expect(await pollUntil(consumer, 4)).toEqual(["processed", "processed", "duplicate", "duplicate"]);

    expect(await journalOf(walletId)).toHaveLength(1);
    expect(await playerAccountBalance(walletId)).toBe("-25.00");
    expect(await accountingInboxRows(consumer.consumerName, bet.balance.eventId)).toBe(1);
    expect(consumer.posted()).toBe(1);
  });
});

describe("D27.5: permanentes → DLQ própria, intactos, nada lançado", () => {
  it("D27.5: envelope inválido → DLQ intacto", async () => {
    const walletId = newId();
    const invalid = JSON.stringify({ eventId: newId(), eventType: "WalletBalanceChanged", data: { walletId } });
    await sendMessage(queues.queueUrl, invalid, { groupId: walletId, attributes: ORIGIN_ATTRIBUTES });
    const consumer = await consumerFor();

    expect(await pollUntil(consumer, 1)).toEqual(["dead_lettered"]);

    const [copy] = await receiveMessages(queues.dlqUrl, 1);
    expect(copy?.Body).toBe(invalid);
    expect(plainAttributes(copy?.MessageAttributes)).toEqual(plainAttributes(ORIGIN_ATTRIBUTES));
  });

  it("D3.8 D27.5: mesmo eventId com outro conteúdo → DLQ; a primeira versão continua sendo a gravada", async () => {
    const walletId = newId();
    const transactionId = newId();
    const first = balanceChanged({ walletId, transactionId, direction: "DEBIT", amount: "25.00", before: "100.00", after: "75.00", walletVersion: 2 });
    const tampered = balanceChanged({
      walletId,
      transactionId,
      eventId: first.eventId,
      direction: "DEBIT",
      amount: "26.00",
      before: "100.00",
      after: "74.00",
      walletVersion: 2,
    });
    await send(walletId, first, tampered);
    const consumer = await consumerFor();

    expect(await pollUntil(consumer, 2)).toEqual(["processed", "dead_lettered"]);
    expect((await receiveMessages(queues.dlqUrl, 1))[0]?.Body).toBe(tampered.body);
    expect(await receivedHalves(transactionId)).toEqual(["WalletBalanceChanged"]);
  });

  it("D27.4 D27.5: outra metade do mesmo tipo para a transação (outro eventId) → DLQ", async () => {
    const walletId = newId();
    const transactionId = newId();
    const common = { walletId, transactionId, direction: "DEBIT" as const, amount: "25.00", before: "100.00", after: "75.00", walletVersion: 2 };
    const first = balanceChanged(common);
    const second = balanceChanged(common);
    await send(walletId, first, second);
    const consumer = await consumerFor();

    expect(await pollUntil(consumer, 2)).toEqual(["processed", "dead_lettered"]);
    expect((await receiveMessages(queues.dlqUrl, 1))[0]?.Body).toBe(second.body);
  });

  it.each([
    ["valor diferente", { amount: "24.00" }],
    ["versão diferente", { walletVersion: 3 }],
    ["balanceAfter diferente", { after: "74.00" }],
  ])("D27.4 D27.5: par incoerente (%s) → a segunda metade vai para a DLQ, nada lançado", async (_name, change) => {
    const walletId = newId();
    const transactionId = newId();
    const balance = balanceChanged({ walletId, transactionId, direction: "DEBIT", amount: "25.00", before: "100.00", after: "75.00", walletVersion: 2 });
    const processed = transactionProcessed({ walletId, transactionId, kind: "BET", amount: "25.00", after: "75.00", walletVersion: 2, ...change });
    await send(walletId, balance, processed);
    const consumer = await consumerFor();

    expect(await pollUntil(consumer, 2)).toEqual(["processed", "dead_lettered"]);
    expect((await receiveMessages(queues.dlqUrl, 1))[0]?.Body).toBe(processed.body);
    expect(await journalOf(walletId)).toEqual([]);
    expect(await receivedHalves(transactionId)).toEqual(["WalletBalanceChanged"]);
  });

  it("D27.2 D27.5: BET com crédito na wallet (kind e direção incompatíveis) → DLQ, nada lançado", async () => {
    const walletId = newId();
    const bet = pair({ walletId, kind: "BET", direction: "CREDIT", amount: "25.00", before: "100.00", after: "125.00", walletVersion: 2 });
    await send(walletId, bet.processed, bet.balance);
    const consumer = await consumerFor();

    expect(await pollUntil(consumer, 2)).toEqual(["processed", "dead_lettered"]);
    expect(await journalOf(walletId)).toEqual([]);
  });

  it("D27.4 D27.5: metade numa moeda diferente da conta da wallet → DLQ", async () => {
    const walletId = newId();
    const brl = pair({ walletId, kind: "OPENING", direction: "CREDIT", amount: "100.00", before: "0.00", after: "100.00", walletVersion: 1 });
    const usd = balanceChanged({
      walletId,
      transactionId: newId(),
      direction: "DEBIT",
      amount: "1.00",
      before: "100.00",
      after: "99.00",
      walletVersion: 2,
      currency: "USD",
    });
    await send(walletId, brl.processed, brl.balance, usd);
    const consumer = await consumerFor();

    expect(await pollUntil(consumer, 3)).toEqual(["processed", "processed", "dead_lettered"]);
  });
});

/**
 * Trava, numa transação aberta do `accounting_app`, a conta da wallet que o
 * consumidor vai travar (D27.4): ele espera e cai no `lock_timeout` (2 s).
 */
async function holdPlayerAccount(walletId: string): Promise<{ release(): Promise<void> }> {
  const holder = await connect("accounting");
  await holder.query("BEGIN");
  await holder.query(
    `INSERT INTO accounting.accounts (id, code, nature, currency, wallet_id)
     VALUES ($1, 'PLAYER_WALLET', 'LIABILITY', 'BRL', $2) ON CONFLICT (wallet_id) DO NOTHING`,
    [newId(), walletId],
  );
  await holder.query("SELECT id FROM accounting.accounts WHERE wallet_id = $1 FOR UPDATE", [walletId]);
  return {
    async release() {
      await holder.query("ROLLBACK");
      await holder.end();
    },
  };
}

describe("D27.5 D8.3: transitório → tentativas contadas no accounting.message_attempts", () => {
  it("D27.4 D27.5 D19.11: conta da wallet travada (lock_timeout) → retry contado com consumer_name = accounting-consumer; solta, lança e apaga as tentativas", async () => {
    const walletId = newId();
    const bet = pair({ walletId, kind: "BET", direction: "DEBIT", amount: "25.00", before: "100.00", after: "75.00", walletVersion: 2 });
    await send(walletId, bet.balance);
    const consumer = await consumerFor({ consumerName: ACCOUNTING_CONSUMER_NAME });
    expect(consumer.consumerName).toBe("accounting-consumer");
    const lock = await holdPlayerAccount(walletId);
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        expect(await pollUntil(consumer, 1)).toEqual(["retry_scheduled"]);
        expect(await accountingAttempts(ACCOUNTING_CONSUMER_NAME, bet.balance.eventId)).toEqual({
          attempts: attempt,
          last_error_code: "TEMPORARILY_UNAVAILABLE",
        });
      }
    } finally {
      await lock.release();
    }

    expect(await pollUntil(consumer, 1)).toEqual(["processed"]);
    expect(await accountingAttempts(ACCOUNTING_CONSUMER_NAME, bet.balance.eventId)).toBeUndefined();
    expect(await receivedHalves(bet.transactionId)).toEqual(["WalletBalanceChanged"]);
  }, 30_000);
});

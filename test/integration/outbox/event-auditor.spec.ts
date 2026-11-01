import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { startTestApi } from "../../support/api";
import { auditedRows, envelopeJson, startTestAuditor, type TestAuditor } from "../../support/auditor";
import { inboxRows, pollUntil } from "../../support/consumer";
import { newId } from "../../support/db";
import { expectLedgerMatchesBalances } from "../../support/db-ledger-invariant";
import {
  createTestTopic,
  outboxIdsOf,
  parkAllOutbox,
  runPublisherUntil,
  startTestPublisher,
  unpublishedCount,
} from "../../support/outbox";
import {
  createTestQueues,
  ORIGIN_ATTRIBUTES,
  plainAttributes,
  queueCounts,
  receiveMessages,
  sendMessage,
  type TestQueues,
} from "../../support/sqs";
import { brl, createWallet, submit, wagerBody } from "../../support/wagering";

/** A subida da API e as idas ao LocalStack não cabem nos 5 s padrão do bun. */
const SLOW_TEST_MS = 30_000;

let queues: TestQueues;
const auditors: TestAuditor[] = [];

beforeEach(async () => {
  queues = await createTestQueues();
});

afterEach(async () => {
  for (const auditor of auditors.splice(0)) await auditor.close();
  await queues.destroy();
  await expectLedgerMatchesBalances();
});

async function auditorFor(target: { queueUrl: string; dlqUrl: string } = queues): Promise<TestAuditor> {
  const auditor = await startTestAuditor(target);
  auditors.push(auditor);
  return auditor;
}

describe("R-11-03 D9.7 D20.6: publicação duplicada continua segura para o consumidor", () => {
  it("R-11-03 D9.7 D20.6: o mesmo evento entregue duas vezes (fora da janela de deduplicação) → o auditor aplica uma vez", async () => {
    const walletId = newId();
    const event = envelopeJson({ walletId, walletVersion: 2 });
    await sendMessage(queues.queueUrl, event.body, { groupId: walletId, deduplicationId: "copy-1" });
    await sendMessage(queues.queueUrl, event.body, { groupId: walletId, deduplicationId: "copy-2" });
    const auditor = await auditorFor();

    expect(await pollUntil(auditor, 2)).toEqual(["processed", "duplicate"]);

    expect(await auditedRows([event.eventId])).toHaveLength(1);
    expect(await inboxRows(auditor.consumerName, event.eventId)).toBe(1);
    expect(await queueCounts(queues.queueUrl)).toEqual({ visible: 0, inFlight: 0 });
  });
});

describe("D20.2: erros permanentes do auditor → DLQ própria, intactos", () => {
  it("D20.2: mesmo eventId com outro conteúdo → DLQ, intacto; a primeira versão fica auditada", async () => {
    const walletId = newId();
    const first = envelopeJson({ walletId, walletVersion: 2 });
    const tampered = envelopeJson({ walletId, walletVersion: 3, eventId: first.eventId });
    await sendMessage(queues.queueUrl, first.body, { groupId: walletId });
    await sendMessage(queues.queueUrl, tampered.body, { groupId: walletId, attributes: ORIGIN_ATTRIBUTES });
    const auditor = await auditorFor();

    expect(await pollUntil(auditor, 2)).toEqual(["processed", "dead_lettered"]);

    const [copy] = await receiveMessages(queues.dlqUrl, 1);
    expect(copy?.Body).toBe(tampered.body);
    expect(plainAttributes(copy?.MessageAttributes)).toEqual(plainAttributes(ORIGIN_ATTRIBUTES));
    expect((await auditedRows([first.eventId])).map((row) => row.wallet_version)).toEqual([2]);
  });

  it("D20.2: envelope inválido → DLQ, intacto, nada auditado", async () => {
    const walletId = newId();
    const invalid = envelopeJson({ walletId, data: { walletVersion: 0 } });
    await sendMessage(queues.queueUrl, invalid.body, { groupId: walletId });
    const auditor = await auditorFor();

    expect(await pollUntil(auditor, 1)).toEqual(["dead_lettered"]);

    expect((await receiveMessages(queues.dlqUrl, 1))[0]?.Body).toBe(invalid.body);
    expect(await auditedRows([invalid.eventId])).toEqual([]);
  });
});

describe("D20.1: checagem de ordem por (wallet, tipo de evento)", () => {
  it("D20.1: Processed e BalanceChanged com a mesma versão não disparam o alarme; BalanceChanged com versão menor dispara, e a linha é gravada", async () => {
    const walletId = newId();
    const events = [
      envelopeJson({ walletId, eventType: "WagerTransactionProcessed", walletVersion: 2 }),
      envelopeJson({ walletId, eventType: "WalletBalanceChanged", walletVersion: 2 }),
      envelopeJson({ walletId, eventType: "WalletBalanceChanged", walletVersion: 3 }),
      envelopeJson({ walletId, eventType: "WalletBalanceChanged", walletVersion: 2 }),
    ];
    for (const event of events) await sendMessage(queues.queueUrl, event.body, { groupId: walletId });
    const auditor = await auditorFor();

    expect(await pollUntil(auditor, 4)).toEqual(["processed", "processed", "processed", "processed"]);

    const rows = await auditedRows(events.map((event) => event.eventId));
    expect(rows.map((row) => [row.event_type, row.wallet_version, row.in_order])).toEqual([
      ["WagerTransactionProcessed", 2, true],
      ["WalletBalanceChanged", 2, true],
      ["WalletBalanceChanged", 3, true],
      ["WalletBalanceChanged", 2, false],
    ]);
    expect(auditor.outOfOrder()).toBe(1);
  });
});

describe("R-11-03 D9.2 D20.1: da API ao auditor", () => {
  it("R-11-03 D9.2 D20.1: BETs pela API → outbox → publisher → SNS → auditor: tudo auditado na ordem da outbox, nenhum fora de ordem", async () => {
    await parkAllOutbox();
    const topic = await createTestTopic();
    const publisher = await startTestPublisher(topic);
    try {
      const api = await startTestApi();
      let walletId: string;
      try {
        const wallet = await createWallet(api, brl("100.00"));
        walletId = wallet.id;
        for (let bet = 0; bet < 3; bet++) expect((await submit(api, wagerBody(wallet))).status).toBe(200);
      } finally {
        await api.close();
      }
      const expected = await outboxIdsOf(walletId);
      await runPublisherUntil(publisher, async () => (await unpublishedCount([walletId])) === 0);

      // A fila assinante do tópico é a fila do auditor; a DLQ é a do par de filas do teste.
      const auditor = await auditorFor({ queueUrl: topic.queueUrl, dlqUrl: queues.dlqUrl });
      const outcomes = await pollUntil(auditor, expected.length);

      expect(outcomes).toEqual(expected.map(() => "processed"));
      const rows = await auditedRows(expected);
      expect(rows.map((row) => row.event_id)).toEqual(expected);
      expect(rows.filter((row) => row.in_order === false)).toEqual([]);
      expect(rows.filter((row) => row.event_type === "WalletBalanceChanged").map((row) => row.wallet_version)).toEqual([
        1, 2, 3, 4,
      ]);
      expect(auditor.outOfOrder()).toBe(0);
    } finally {
      await publisher.close();
      await topic.destroy();
    }
  }, SLOW_TEST_MS);
});

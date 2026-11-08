import { describe, expect, it } from "bun:test";
import { journalOf, playerAccountBalance, reconcileWallets, startTestAccountingConsumer } from "../../support/accounting";
import { startTestApi } from "../../support/api";
import { pollUntil } from "../../support/consumer";
import { expectLedgerMatchesBalances } from "../../support/db-ledger-invariant";
import {
  createTestTopic,
  outboxIdsOf,
  parkAllOutbox,
  runPublisherUntil,
  startTestPublisher,
  subscribeQueue,
  unpublishedCount,
} from "../../support/outbox";
import { createTestQueues } from "../../support/sqs";
import { brl, createWallet, submit, wagerBody } from "../../support/wagering";

/** A subida da API e as idas ao LocalStack não cabem nos 5 s padrão do bun. */
const SLOW_TEST_MS = 60_000;

describe("§6.4 D12.1 D27: do núcleo ao diário de partidas dobradas", () => {
  it("D12.1 D27.1 D27.7: API → outbox → publisher → SNS → accounting: cada kind lançado, saldo da conta = saldo da wallet, reconciliação consistente e trial balance zero", async () => {
    await parkAllOutbox();
    const topic = await createTestTopic();
    const queues = await createTestQueues();
    await subscribeQueue(topic, queues.queueUrl);
    const publisher = await startTestPublisher(topic);
    const consumer = await startTestAccountingConsumer(queues);
    try {
      const api = await startTestApi();
      let walletId: string;
      try {
        const wallet = await createWallet(api, brl("100.00"));
        walletId = wallet.id;
        const ok = async (overrides: Record<string, unknown>) => {
          const body = wagerBody(wallet, overrides);
          const response = await submit(api, body);
          expect({ kind: overrides.kind, status: response.status }).toEqual({ kind: overrides.kind, status: 200 });
          return body.externalTransactionId;
        };
        const bet1 = await ok({ kind: "BET", money: brl("30.00") });
        await ok({ kind: "REFUND", money: brl("30.00"), referenceExternalTransactionId: bet1 });
        const win = await ok({ kind: "WIN", money: brl("15.00") });
        await ok({ kind: "ROLLBACK", money: brl("15.00"), referenceExternalTransactionId: win });
        const bet2 = await ok({ kind: "BET", money: brl("10.00") });
        await ok({ kind: "ROLLBACK", money: brl("10.00"), referenceExternalTransactionId: bet2 });
        await ok({ kind: "BET", money: brl("40.00") });
        await ok({ kind: "LOSS", money: brl("0.00") });
        // Rejeitada por saldo: nada muda, nada é lançado (§6.4).
        expect((await submit(api, wagerBody(wallet, { kind: "BET", money: brl("1000.00") }))).status).toBe(422);
      } finally {
        await api.close();
      }

      const expected = await outboxIdsOf(walletId);
      await runPublisherUntil(publisher, async () => (await unpublishedCount([walletId])) === 0);
      await pollUntil(consumer, expected.length, 30);

      expect((await journalOf(walletId)).map((entry) => [entry.kind, entry.wallet_version])).toEqual([
        ["OPENING", 1],
        ["BET", 2],
        ["REFUND", 3],
        ["WIN", 4],
        ["ROLLBACK", 5],
        ["BET", 6],
        ["ROLLBACK", 7],
        ["BET", 8],
      ]);
      expect(await playerAccountBalance(walletId)).toBe("60.00");

      const report = await reconcileWallets([walletId]);
      expect(report.wallets).toEqual([{ walletId, status: "consistent", postedVersion: 8, coreVersion: 8, issues: [] }]);
      expect(report.trialBalance.every((row) => row.balanced)).toBe(true);
      expect(report.consistent).toBe(true);
      expect(report.settled).toBe(true);
      await expectLedgerMatchesBalances();
    } finally {
      await consumer.close();
      await publisher.close();
      await queues.destroy();
      await topic.destroy();
    }
  }, SLOW_TEST_MS);

  it("D27.1 D27.7: wallet aberta com saldo zero → nenhum lançamento, consistente", async () => {
    const api = await startTestApi();
    try {
      const wallet = await createWallet(api, brl("0.00"));

      const report = await reconcileWallets([wallet.id]);
      expect(report.wallets).toEqual([{ walletId: wallet.id, status: "consistent", postedVersion: null, coreVersion: 1, issues: [] }]);
    } finally {
      await api.close();
    }
  }, SLOW_TEST_MS);
});

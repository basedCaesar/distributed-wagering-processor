import { describe, expect, it } from "bun:test";
import type {
  LockedPending,
  RefundAfterSettlement,
  TransactionDecision,
  TransactionMetrics,
  TransactionScope,
  UnitOfWork,
} from "../../../src/modules/wagering/application/ports";
import { ResolvePendingTransactionUseCase } from "../../../src/modules/wagering/application/resolve-pending-transaction.use-case";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../src/modules/wagering/domain/wager-transaction";
import type { ReferenceLookup } from "../../../src/modules/wagering/domain/wager-transaction-rules";
import { Wallet } from "../../../src/modules/wagering/domain/wallet";
import { brl, submissionProps, T0 } from "../../support/wager-fixtures";

/** D22.2 e D22.8 no worker: conta com `channel=worker`, depois do commit. */

const WALLET_ID = "wallet-1";
const LEASE_TOKEN = "lease-worker-a";
const claimed = { id: "refund-1", walletId: WALLET_ID, leaseToken: LEASE_TOKEN };

const wallet = () =>
  Wallet.rehydrate({
    id: WALLET_ID,
    playerId: "player-1",
    currency: "BRL",
    balance: brl("100.00"),
    version: 1,
    createdAt: T0,
    updatedAt: T0,
  });

function pendingRefund(): LockedPending {
  const tx = WagerTransaction.create(
    submissionProps({
      id: "refund-1",
      kind: WagerTransactionKind.Refund,
      money: brl("10.00"),
      referenceExternalTransactionId: "bet-1",
      createdAt: T0,
    }),
  );
  tx.markPendingReference();
  return { transaction: tx, control: { attempts: 4, consecutiveErrors: 4 }, correlationId: "corr", lockedBy: LEASE_TOKEN };
}

function processedBet(): WagerTransaction {
  const tx = WagerTransaction.create(
    submissionProps({ id: "bet-tx", externalTransactionId: "bet-1", money: brl("10.00") }),
  );
  tx.markProcessed({ balanceAfter: brl("90.00"), at: T0 });
  return tx;
}

function fake(options: { reference?: ReferenceLookup; settled?: boolean; commitError?: Error }) {
  const scope = {
    now: async () => T0,
    wallets: { lockById: async () => wallet(), update: () => {} },
    transactions: {
      lockPending: async () => pendingRefund(),
      findReference: async () => options.reference ?? { found: false },
      isSettled: async () => options.settled ?? false,
      resolve: () => {},
      reschedule: () => {},
      nudgeDependents: async () => {},
    },
    ledger: { insert: () => {} },
    outbox: { append: () => {} },
  } as unknown as TransactionScope;
  const uow: UnitOfWork = {
    async run(work) {
      const result = await work(scope);
      if (options.commitError) throw options.commitError;
      return result;
    },
  };
  const decisions: TransactionDecision[] = [];
  const refunds: RefundAfterSettlement[] = [];
  const metrics: TransactionMetrics = {
    countDecision: (decision) => decisions.push(decision),
    countSubmissionRetry: () => {},
    refundAfterSettlement: (event) => refunds.push(event),
  };
  let sequence = 0;
  const useCase = new ResolvePendingTransactionUseCase(uow, { next: () => `id-${++sequence}` }, metrics);
  return { useCase, decisions, refunds };
}

const found = (): ReferenceLookup => ({ found: true, transaction: processedBet(), alreadyReversed: false });

describe("D22.2: decisões do worker", () => {
  it("D22.2: pendente resolvida → uma decisão PROCESSED com channel=worker", async () => {
    const { useCase, decisions } = fake({ reference: found() });

    await useCase.attempt(claimed);

    expect(decisions).toEqual([
      { status: WagerTransactionStatus.Processed, kind: WagerTransactionKind.Refund, channel: "worker" },
    ]);
  });

  it("D22.2: ainda pendente (reagendada) → nenhuma decisão", async () => {
    const { useCase, decisions } = fake({});

    const result = await useCase.attempt(claimed);

    expect(result.kind).toBe("rescheduled");
    expect(decisions).toEqual([]);
  });

  it("D22.2 D4.2: o 5º erro seguido grava FAILED → uma decisão FAILED com channel=worker", async () => {
    const { useCase, decisions } = fake({});

    const result = await useCase.recordError(claimed, { transient: false });

    expect(result).toEqual({ kind: "resolved", status: WagerTransactionStatus.Failed });
    expect(decisions).toEqual([
      { status: WagerTransactionStatus.Failed, kind: WagerTransactionKind.Refund, channel: "worker" },
    ]);
  });

  it("D22.2: commit que falha não conta", async () => {
    const { useCase, decisions } = fake({ reference: found(), commitError: new Error("commit falhou") });

    await expect(useCase.attempt(claimed)).rejects.toThrow("commit falhou");

    expect(decisions).toEqual([]);
  });
});

describe("D1.7 D22.8: REFUND pendente resolvido sobre BET liquidada", () => {
  it("D1.7 D22.8: aplicado → refundAfterSettlement com channel=worker", async () => {
    const { useCase, refunds } = fake({ reference: found(), settled: true });

    await useCase.attempt(claimed);

    expect(refunds).toEqual([
      { channel: "worker", transactionId: "refund-1", walletId: WALLET_ID, referenceTransactionId: "bet-tx" },
    ]);
  });

  it("D1.7 D22.8: BET não liquidada → nada", async () => {
    const { useCase, refunds } = fake({ reference: found(), settled: false });

    await useCase.attempt(claimed);

    expect(refunds).toEqual([]);
  });
});

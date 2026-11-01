import { describe, expect, it } from "bun:test";
import type {
  LockedPending,
  PendingControl,
  TransactionScope,
  UnitOfWork,
} from "../../../src/modules/wagering/application/ports";
import { ResolvePendingTransactionUseCase } from "../../../src/modules/wagering/application/resolve-pending-transaction.use-case";
import type { IntegrationEvent } from "../../../src/modules/wagering/domain/events/integration-event";
import { FailureCode } from "../../../src/modules/wagering/domain/failure-code";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../src/modules/wagering/domain/wager-transaction";
import type { ReferenceLookup } from "../../../src/modules/wagering/domain/wager-transaction-rules";
import { Wallet } from "../../../src/modules/wagering/domain/wallet";
import { brl, submissionProps, T0 } from "../../support/wager-fixtures";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const WALLET_ID = "wallet-1";

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

/** `REFUND` gravado como `PENDING_REFERENCE` em T0, esperando `bet-1`. */
function pendingRefund(): WagerTransaction {
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
  return tx;
}

/** `BET` `PROCESSED` de 10.00, a referência do `REFUND`. */
function processedBet(): WagerTransaction {
  const tx = WagerTransaction.create(
    submissionProps({ id: "bet-tx", externalTransactionId: "bet-1", money: brl("10.00") }),
  );
  tx.markProcessed({ balanceAfter: brl("90.00"), at: T0 });
  return tx;
}

interface FakeOptions {
  pending?: LockedPending | undefined;
  reference?: ReferenceLookup;
  now: Date;
}

/** Escopo em memória que registra o que o use case fez, na ordem. */
function fake(options: FakeOptions) {
  const calls: string[] = [];
  const events: IntegrationEvent<unknown>[] = [];
  const written: {
    resolved?: { tx: WagerTransaction; control: PendingControl };
    rescheduled?: PendingControl & { nextAttemptAt: Date };
    nudged?: WagerTransaction;
    ledger: number;
    walletUpdated: boolean;
  } = { ledger: 0, walletUpdated: false };
  const scope = {
    wallets: {
      lockById: async () => {
        calls.push("lockWallet");
        return wallet();
      },
      update: () => {
        written.walletUpdated = true;
      },
    },
    transactions: {
      lockPending: async () => {
        calls.push("lockPending");
        return options.pending;
      },
      findReference: async () => {
        calls.push("findReference");
        return options.reference ?? { found: false };
      },
      resolve: (tx: WagerTransaction, control: PendingControl) => {
        written.resolved = { tx, control };
      },
      reschedule: (_id: string, control: PendingControl & { nextAttemptAt: Date }) => {
        written.rescheduled = control;
      },
      nudgeDependents: async (tx: WagerTransaction) => {
        written.nudged = tx;
      },
    },
    ledger: {
      insert: () => {
        written.ledger += 1;
      },
    },
    outbox: {
      append: (appended: readonly IntegrationEvent<unknown>[], orderingKey: string) => {
        expect(orderingKey).toBe(WALLET_ID);
        events.push(...appended);
      },
    },
  } as unknown as TransactionScope;
  const uow: UnitOfWork = { run: (work) => work(scope) };
  let sequence = 0;
  const useCase = new ResolvePendingTransactionUseCase(
    uow,
    { next: () => `id-${++sequence}` },
    { now: () => options.now },
  );
  return { useCase, calls, events, written };
}

const locked = (
  control: PendingControl = { attempts: 0, consecutiveErrors: 0 },
): LockedPending => ({
  transaction: pendingRefund(),
  control,
  correlationId: "corr-original",
});

const claimed = { id: "refund-1", walletId: WALLET_ID };
const found = (): ReferenceLookup => ({
  found: true,
  transaction: processedBet(),
  alreadyReversed: false,
});

describe("D4.3 D4.4 D18: ResolvePendingTransactionUseCase.attempt", () => {
  it("D7.2 CLAUDE.md: trava a wallet antes da linha pendente e só então busca a referência", async () => {
    const { useCase, calls } = fake({ pending: locked(), now: T0 });

    await useCase.attempt(claimed);

    expect(calls).toEqual(["lockWallet", "lockPending", "findReference"]);
  });

  it("R-07-20 D4.3 D4.6 D18.1: referência ainda ausente → reagenda com attempts + 1, erros zerados, backoff de 1 s, sem evento nem cutucada", async () => {
    const now = new Date(T0.getTime() + 5 * SECOND);
    const { useCase, events, written } = fake({
      pending: locked({ attempts: 0, consecutiveErrors: 3 }),
      now,
    });

    const result = await useCase.attempt(claimed);

    expect(result).toEqual({ kind: "rescheduled", nextAttemptAt: new Date(now.getTime() + SECOND) });
    expect(written.rescheduled).toEqual({
      attempts: 1,
      consecutiveErrors: 0,
      nextAttemptAt: new Date(now.getTime() + SECOND),
    });
    expect(written.resolved).toBeUndefined();
    expect(written.nudged).toBeUndefined();
    expect(events).toEqual([]);
  });

  it("R-13-C7 D4.4 D9.5 D18.3 D18.6: referência chegou → PROCESSED, lançamento, eventos com o correlationId original e a causação da tentativa, cutucada", async () => {
    const { useCase, events, written } = fake({
      pending: locked({ attempts: 2, consecutiveErrors: 1 }),
      reference: found(),
      now: T0,
    });

    const result = await useCase.attempt(claimed);

    expect(result).toEqual({ kind: "resolved", status: WagerTransactionStatus.Processed });
    expect(written.resolved?.tx.status).toBe(WagerTransactionStatus.Processed);
    expect(written.resolved?.tx.referenceTransactionId).toBe("bet-tx");
    expect(written.resolved?.control).toEqual({ attempts: 3, consecutiveErrors: 0 });
    expect(written.walletUpdated).toBe(true);
    expect(written.ledger).toBe(1);
    expect(written.nudged?.id).toBe("refund-1");
    expect(events.map((event) => event.eventType)).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
    const attemptId = events[0]?.causationId;
    for (const event of events) {
      expect(event.correlationId).toBe("corr-original");
      expect(event.causationId).toBe(attemptId as string);
    }
  });

  it("R-07-21 R-07-22 D4.3 D18.5: prazo esgotado e referência ausente → REJECTED REFERENCE_NOT_FOUND, evento, cutucada", async () => {
    const { useCase, events, written } = fake({
      pending: locked(),
      now: new Date(T0.getTime() + 15 * MINUTE),
    });

    const result = await useCase.attempt(claimed);

    expect(result).toEqual({ kind: "resolved", status: WagerTransactionStatus.Rejected });
    expect(written.resolved?.tx.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(written.resolved?.tx.balanceAfter?.toString()).toBe("100.00");
    expect(written.ledger).toBe(0);
    expect(written.nudged?.id).toBe("refund-1");
    expect(events.map((event) => event.eventType)).toEqual(["WagerTransactionRejected"]);
  });

  it("D18.5: prazo esgotado mas a referência chegou → aplicada, não expirada", async () => {
    const { useCase, written } = fake({
      pending: locked(),
      reference: found(),
      now: new Date(T0.getTime() + 20 * MINUTE),
    });

    const result = await useCase.attempt(claimed);

    expect(result).toEqual({ kind: "resolved", status: WagerTransactionStatus.Processed });
    expect(written.resolved?.tx.failureCode).toBeUndefined();
  });

  it("D4.3: a linha já não está pendente (outro worker resolveu) → skipped, nada gravado", async () => {
    const done = pendingRefund();
    done.reject(FailureCode.ReferenceNotFound, { balanceAfter: brl("100.00") });
    const { useCase, calls, events, written } = fake({
      pending: { transaction: done, control: { attempts: 1, consecutiveErrors: 0 }, correlationId: null },
      now: T0,
    });

    expect(await useCase.attempt(claimed)).toEqual({ kind: "skipped" });
    expect(calls).toEqual(["lockWallet", "lockPending"]);
    expect(written.resolved).toBeUndefined();
    expect(written.rescheduled).toBeUndefined();
    expect(events).toEqual([]);
  });
});

describe("D4.2 D18.4: ResolvePendingTransactionUseCase.recordError", () => {
  it("D18.4: erro não transitório → attempts + 1, consecutive_errors + 1, backoff", async () => {
    const now = new Date(T0.getTime() + 10 * SECOND);
    const { useCase, written, events } = fake({
      pending: locked({ attempts: 2, consecutiveErrors: 1 }),
      now,
    });

    const result = await useCase.recordError(claimed, { transient: false });

    expect(result).toEqual({ kind: "rescheduled", nextAttemptAt: new Date(now.getTime() + 4 * SECOND) });
    expect(written.rescheduled).toEqual({
      attempts: 3,
      consecutiveErrors: 2,
      nextAttemptAt: new Date(now.getTime() + 4 * SECOND),
    });
    expect(events).toEqual([]);
  });

  it("D18.4: erro transitório → attempts + 1, consecutive_errors igual", async () => {
    const { useCase, written } = fake({
      pending: locked({ attempts: 0, consecutiveErrors: 4 }),
      now: T0,
    });

    await useCase.recordError(claimed, { transient: true });

    expect(written.rescheduled).toMatchObject({ attempts: 1, consecutiveErrors: 4 });
    expect(written.resolved).toBeUndefined();
  });

  it("D4.2 D14.1 D18.4: 5º erro seguido → FAILED PROCESSING_FAILED, evento WagerTransactionFailed, cutucada, trava a wallet antes", async () => {
    const { useCase, calls, written, events } = fake({
      pending: locked({ attempts: 4, consecutiveErrors: 4 }),
      now: T0,
    });

    const result = await useCase.recordError(claimed, { transient: false });

    expect(result).toEqual({ kind: "resolved", status: WagerTransactionStatus.Failed });
    expect(calls).toEqual(["lockWallet", "lockPending"]);
    expect(written.resolved?.tx.status).toBe(WagerTransactionStatus.Failed);
    expect(written.resolved?.tx.failureCode).toBe(FailureCode.ProcessingFailed);
    expect(written.resolved?.control).toEqual({ attempts: 5, consecutiveErrors: 5 });
    expect(written.nudged?.id).toBe("refund-1");
    expect(events.map((event) => event.eventType)).toEqual(["WagerTransactionFailed"]);
    expect(events[0]?.correlationId).toBe("corr-original");
  });

  it("D4.2: a linha já não está pendente → skipped", async () => {
    const { useCase } = fake({ pending: undefined, now: T0 });

    expect(await useCase.recordError(claimed, { transient: false })).toEqual({ kind: "skipped" });
  });
});

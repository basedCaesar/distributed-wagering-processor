import { describe, expect, it } from "bun:test";
import { DuplicateTransactionError } from "../../../src/modules/wagering/application/errors";
import { payloadHash } from "../../../src/modules/wagering/application/payload-hash";
import type {
  RefundAfterSettlement,
  TransactionDecision,
  TransactionMetrics,
  TransactionScope,
  UnitOfWork,
} from "../../../src/modules/wagering/application/ports";
import {
  type SubmitWagerTransactionCommand,
  SubmitWagerTransactionUseCase,
} from "../../../src/modules/wagering/application/submit-wager-transaction.use-case";
import type { ReferenceLookup } from "../../../src/modules/wagering/domain/wager-transaction-rules";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../src/modules/wagering/domain/wager-transaction";
import { Wallet } from "../../../src/modules/wagering/domain/wallet";
import { brl, T0 } from "../../support/wager-fixtures";

/**
 * D22.2, D22.3 e D22.8 na `application/`: o use case conta pela porta
 * `TransactionMetrics`, sempre **depois** do commit.
 */

const WALLET_ID = "0192f291-27dd-7d3f-8071-5f8685deef37";

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

const bet: SubmitWagerTransactionCommand = {
  idempotencyKey: "provider-a:tx-1",
  providerId: "provider-a",
  externalTransactionId: "tx-1",
  playerId: "player-1",
  walletId: WALLET_ID,
  roundId: "round-1",
  gameId: "game-1",
  kind: WagerTransactionKind.Bet,
  money: brl("10.00"),
  referenceExternalTransactionId: undefined,
};

const refund: SubmitWagerTransactionCommand = {
  ...bet,
  idempotencyKey: "provider-a:tx-2",
  externalTransactionId: "tx-2",
  kind: WagerTransactionKind.Refund,
  referenceExternalTransactionId: "tx-1",
};

/** A BET `PROCESSED` que o REFUND referencia. */
function processedBet(): WagerTransaction {
  const tx = WagerTransaction.create({
    id: "0192f298-345e-7e38-af88-e43f851a8100",
    providerId: bet.providerId,
    externalTransactionId: bet.externalTransactionId,
    idempotencyKey: bet.idempotencyKey,
    payloadHash: payloadHash(bet),
    walletId: bet.walletId,
    playerId: bet.playerId,
    roundId: bet.roundId,
    gameId: bet.gameId,
    kind: bet.kind,
    money: bet.money,
    referenceExternalTransactionId: undefined,
    createdAt: T0,
  });
  tx.markProcessed({ balanceAfter: brl("90.00"), at: T0 });
  return tx;
}

interface FakeOptions {
  /** O que a checagem (rápida e sob o lock) da key enxerga. */
  existing?: WagerTransaction;
  reference?: ReferenceLookup;
  /** `isSettled` da referência (D22.8). */
  settled?: boolean;
  /** Commits (a partir da 2ª chamada de `run`) que falham com `DuplicateTransactionError`. */
  duplicateCommits?: number;
  /** O commit falha com um erro qualquer, depois de o trabalho rodar. */
  commitError?: Error;
}

function fakeUow(options: FakeOptions = {}) {
  let runs = 0;
  let duplicatesLeft = options.duplicateCommits ?? 0;
  const settledQueries: string[] = [];
  const scope = {
    now: async () => T0,
    inbox: { register: async () => "new" },
    wallets: { lockById: async () => wallet(), update: () => {} },
    transactions: {
      findByProviderAndKey: async () => options.existing,
      findByProviderAndExternalId: async () => undefined,
      findReference: async () => options.reference ?? { found: false },
      isSettled: async (id: string) => {
        settledQueries.push(id);
        return options.settled ?? false;
      },
      insert: () => {},
      nudgeDependents: async () => {},
    },
    ledger: { insert: () => {} },
    outbox: { append: () => {} },
  } as unknown as TransactionScope;
  const uow: UnitOfWork = {
    async run(work) {
      runs += 1;
      const result = await work(scope);
      if (options.commitError) throw options.commitError;
      if (runs > 1 && duplicatesLeft > 0) {
        duplicatesLeft -= 1;
        throw new DuplicateTransactionError("wager_transactions_provider_key_uq");
      }
      return result;
    },
  };
  return { uow, settledQueries };
}

function recordingMetrics() {
  const decisions: TransactionDecision[] = [];
  const refunds: RefundAfterSettlement[] = [];
  let retries = 0;
  const metrics: TransactionMetrics = {
    countDecision: (decision) => decisions.push(decision),
    countSubmissionRetry: () => {
      retries += 1;
    },
    refundAfterSettlement: (event) => refunds.push(event),
  };
  return { metrics, decisions, refunds, retries: () => retries };
}

function useCaseWith(uow: UnitOfWork, metrics: TransactionMetrics) {
  let sequence = 0;
  return new SubmitWagerTransactionUseCase(
    uow,
    { next: () => `0192f2a0-0000-7000-8000-${String(++sequence).padStart(12, "0")}` },
    { countDuplicate: () => {} },
    metrics,
  );
}

const meta = { correlationId: "corr-1", causationId: "req-1" };
const inbox = { consumerName: "wager-transactions", messageId: "msg-1", type: "WagerTransactionRequested" };

describe("D22.2: transações por status, kind e canal, depois do commit", () => {
  it("D22.2: decisão nova pelo HTTP conta uma vez, com channel=http", async () => {
    const { uow } = fakeUow();
    const recorded = recordingMetrics();

    await useCaseWith(uow, recorded.metrics).execute(bet, meta);

    expect(recorded.decisions).toEqual([
      { status: WagerTransactionStatus.Processed, kind: WagerTransactionKind.Bet, channel: "http" },
    ]);
  });

  it("D22.2: com a inbox (fila), conta com channel=sqs", async () => {
    const { uow } = fakeUow();
    const recorded = recordingMetrics();

    await useCaseWith(uow, recorded.metrics).execute(bet, meta, inbox);

    expect(recorded.decisions).toEqual([
      { status: WagerTransactionStatus.Processed, kind: WagerTransactionKind.Bet, channel: "sqs" },
    ]);
  });

  it("D22.2 D17.7: replay não conta como decisão", async () => {
    const existing = processedBet();
    const { uow } = fakeUow({ existing });
    const recorded = recordingMetrics();

    const result = await useCaseWith(uow, recorded.metrics).execute(bet, meta);

    expect(result.idempotentReplay).toBe(true);
    expect(recorded.decisions).toEqual([]);
  });

  it("D22.2: commit que falha não conta nada", async () => {
    const { uow } = fakeUow({ commitError: new Error("commit falhou") });
    const recorded = recordingMetrics();

    await expect(useCaseWith(uow, recorded.metrics).execute(bet, meta)).rejects.toThrow("commit falhou");

    expect(recorded.decisions).toEqual([]);
  });
});

describe("D22.3: retry da submissão", () => {
  it("D22.3 D3.6: a repetição depois do UNIQUE conta um retry de submission", async () => {
    const { uow } = fakeUow({ duplicateCommits: 1 });
    const recorded = recordingMetrics();

    await useCaseWith(uow, recorded.metrics).execute(bet, meta);

    expect(recorded.retries()).toBe(1);
    // A repetição aplicou: uma decisão só.
    expect(recorded.decisions).toHaveLength(1);
  });

  it("D22.3: sem UNIQUE violado, nenhum retry", async () => {
    const { uow } = fakeUow();
    const recorded = recordingMetrics();

    await useCaseWith(uow, recorded.metrics).execute(bet, meta);

    expect(recorded.retries()).toBe(0);
  });
});

describe("D1.7 D22.8: REFUND de BET liquidada", () => {
  it("D1.7 D22.8: REFUND aplicado a uma BET liquidada → PROCESSED e refundAfterSettlement, sem bloquear", async () => {
    const reference = processedBet();
    const { uow, settledQueries } = fakeUow({
      reference: { found: true, transaction: reference, alreadyReversed: false },
      settled: true,
    });
    const recorded = recordingMetrics();

    const result = await useCaseWith(uow, recorded.metrics).execute(refund, meta);

    expect(result.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(settledQueries).toEqual([reference.id]);
    expect(recorded.refunds).toEqual([
      {
        channel: "http",
        transactionId: result.transaction.id,
        walletId: WALLET_ID,
        referenceTransactionId: reference.id,
      },
    ]);
  });

  it("D1.7 D22.8: REFUND de BET não liquidada → nada", async () => {
    const reference = processedBet();
    const { uow } = fakeUow({
      reference: { found: true, transaction: reference, alreadyReversed: false },
      settled: false,
    });
    const recorded = recordingMetrics();

    await useCaseWith(uow, recorded.metrics).execute(refund, meta);

    expect(recorded.refunds).toEqual([]);
  });

  it("D22.8: REFUND rejeitado (já revertida) não consulta a liquidação nem conta", async () => {
    const reference = processedBet();
    const { uow, settledQueries } = fakeUow({
      reference: { found: true, transaction: reference, alreadyReversed: true },
      settled: true,
    });
    const recorded = recordingMetrics();

    const result = await useCaseWith(uow, recorded.metrics).execute(refund, meta);

    expect(result.transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(settledQueries).toEqual([]);
    expect(recorded.refunds).toEqual([]);
  });

  it("D22.8: só o REFUND: uma BET nunca consulta a liquidação", async () => {
    const { uow, settledQueries } = fakeUow({ settled: true });
    const recorded = recordingMetrics();

    await useCaseWith(uow, recorded.metrics).execute(bet, meta);

    expect(settledQueries).toEqual([]);
    expect(recorded.refunds).toEqual([]);
  });
});

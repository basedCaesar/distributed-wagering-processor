import { describe, expect, it } from "bun:test";
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from "../../../src/modules/wagering/domain/domain-error";
import {
  FailureCode,
  ReferenceScopeField,
} from "../../../src/modules/wagering/domain/failure-code";
import {
  WagerTransaction,
  WagerTransactionKind,
  type WagerTransactionState,
  WagerTransactionStatus,
} from "../../../src/modules/wagering/domain/wager-transaction";
import { LedgerDirection } from "../../../src/modules/wagering/domain/wallet-ledger-entry";
import { brl, submissionProps, submit, T0 } from "../../support/wager-fixtures";

const T1 = new Date("2026-10-30T12:00:05.000Z");
const { Bet, Win, Loss, Refund, Rollback, Opening } = WagerTransactionKind;
const { Pending, PendingReference, Processed, Rejected, Failed } =
  WagerTransactionStatus;

function expectInvalid(fn: () => unknown, reason: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidWagerTransactionError);
    expect<string>((error as InvalidWagerTransactionError).reason).toBe(reason);
    return;
  }
  throw new Error(`esperava InvalidWagerTransactionError(${reason})`);
}

describe("WagerTransaction.create", () => {
  it("R-06-33 D4.1: nasce PENDING, sem resultado", () => {
    const tx = submit();

    expect(tx.status).toBe(Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.failureCode).toBeUndefined();
    expect(tx.balanceAfter).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
    expect(tx.referenceTransactionId).toBeUndefined();
  });

  it.each([Refund, Rollback])(
    "R-06-33 R-07-06 D1.5: %s sem referência é inválido",
    (kind) => {
      expectInvalid(() => submit({ kind }), "REFERENCE_REQUIRED");
    },
  );

  it("D1.5: BET com referência é inválido", () => {
    expectInvalid(
      () => submit({ kind: Bet, referenceExternalTransactionId: "ext-x" }),
      "REFERENCE_FORBIDDEN",
    );
  });

  it.each([Win, Loss])("D1.5: %s com ou sem referência é válido", (kind) => {
    expect(submit({ kind }).status).toBe(Pending);
    expect(
      submit({ kind, referenceExternalTransactionId: "ext-x" }).status,
    ).toBe(Pending);
  });

  it("R-06-38 D14.5: create recusa OPENING", () => {
    expectInvalid(() => submit({ kind: Opening }), "OPENING_NOT_SUBMITTABLE");
  });

  it.each([Bet, Win, Refund, Rollback])(
    "D2.3: %s com valor zero é inválido",
    (kind) => {
      const reference =
        kind === Refund || kind === Rollback ? "ext-x" : undefined;
      expectInvalid(
        () =>
          submit({
            kind,
            money: brl("0"),
            referenceExternalTransactionId: reference,
          }),
        "AMOUNT_MUST_BE_POSITIVE",
      );
    },
  );

  it("D2.3: LOSS aceita valor zero", () => {
    expect(submit({ kind: Loss, money: brl("0") }).status).toBe(Pending);
  });

  it("D2.6: valor negativo é inválido mesmo em LOSS", () => {
    expectInvalid(
      () => submit({ kind: Loss, money: brl("1.00").negate() }),
      "AMOUNT_MUST_NOT_BE_NEGATIVE",
    );
  });
});

describe("WagerTransaction.opening", () => {
  it("D6.1 D14.5: OPENING tem as colunas do provedor vazias", () => {
    const tx = WagerTransaction.opening({
      id: "tx-open",
      walletId: "wallet-1",
      playerId: "player-1",
      money: brl("1000.00"),
      createdAt: T0,
    });

    expect(tx.kind).toBe(Opening);
    expect(tx.status).toBe(Pending);
    expect(tx.walletId).toBe("wallet-1");
    expect(tx.playerId).toBe("player-1");
    expect(tx.providerId).toBeUndefined();
    expect(tx.externalTransactionId).toBeUndefined();
    expect(tx.idempotencyKey).toBeUndefined();
    expect(tx.payloadHash).toBeUndefined();
    expect(tx.roundId).toBeUndefined();
    expect(tx.gameId).toBeUndefined();
    expect(tx.referenceExternalTransactionId).toBeUndefined();
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  it("D2.3: OPENING exige valor positivo", () => {
    expectInvalid(
      () =>
        WagerTransaction.opening({
          id: "tx-open",
          walletId: "wallet-1",
          playerId: "player-1",
          money: brl("0"),
          createdAt: T0,
        }),
      "AMOUNT_MUST_BE_POSITIVE",
    );
  });
});

describe("WagerTransaction: transições (D4.5, R-06-36, R-06-37)", () => {
  function inState(status: WagerTransactionStatus): WagerTransaction {
    const base = submissionProps({
      kind: Win,
      referenceExternalTransactionId: "ext-ref",
    });
    const state: WagerTransactionState = {
      ...base,
      status,
      referenceTransactionId: undefined,
      failureCode:
        status === Rejected
          ? FailureCode.InsufficientFunds
          : status === Failed
            ? FailureCode.ProcessingFailed
            : undefined,
      failureDetail: undefined,
      balanceAfter:
        status === Processed || status === Rejected ? brl("1.00") : undefined,
      processedAt: status === Processed ? T0 : undefined,
    };
    return WagerTransaction.rehydrate(state);
  }

  const actions = {
    markProcessed: (tx: WagerTransaction) =>
      tx.markProcessed({
        referenceTransactionId: "tx-ref",
        balanceAfter: brl("5.00"),
        at: T1,
      }),
    markPendingReference: (tx: WagerTransaction) => tx.markPendingReference(),
    reject: (tx: WagerTransaction) =>
      tx.reject(FailureCode.InsufficientFunds, { balanceAfter: brl("5.00") }),
    fail: (tx: WagerTransaction) => tx.fail(FailureCode.ProcessingFailed),
  } as const;

  const expected: Record<
    WagerTransactionStatus,
    Record<keyof typeof actions, WagerTransactionStatus | "erro">
  > = {
    [Pending]: {
      markProcessed: Processed,
      markPendingReference: PendingReference,
      reject: Rejected,
      fail: "erro",
    },
    [PendingReference]: {
      markProcessed: Processed,
      markPendingReference: "erro",
      reject: Rejected,
      fail: Failed,
    },
    [Processed]: {
      markProcessed: "erro",
      markPendingReference: "erro",
      reject: "erro",
      fail: "erro",
    },
    [Rejected]: {
      markProcessed: "erro",
      markPendingReference: "erro",
      reject: "erro",
      fail: "erro",
    },
    [Failed]: {
      markProcessed: "erro",
      markPendingReference: "erro",
      reject: "erro",
      fail: "erro",
    },
  };

  const cases = Object.entries(expected).flatMap(([from, row]) =>
    Object.entries(row).map(
      ([action, to]) =>
        [from, action, to] as [
          WagerTransactionStatus,
          keyof typeof actions,
          string,
        ],
    ),
  );

  it.each(cases)("D4.5 R-06-37: %s --%s--> %s", (from, action, to) => {
    const tx = inState(from);
    if (to === "erro") {
      expect(() => actions[action](tx)).toThrow(InvalidTransactionStateError);
      expect(tx.status).toBe(from);
    } else {
      actions[action](tx);
      expect(tx.status).toBe(to as WagerTransactionStatus);
    }
  });

  it("R-06-36: PROCESSED, REJECTED e FAILED são terminais", () => {
    expect(inState(Processed).isTerminal()).toBe(true);
    expect(inState(Rejected).isTerminal()).toBe(true);
    expect(inState(Failed).isTerminal()).toBe(true);
    expect(inState(Pending).isTerminal()).toBe(false);
    expect(inState(PendingReference).isTerminal()).toBe(false);
  });

  it("D14.6 D3.5: markProcessed grava referência interna, saldo observado e processedAt", () => {
    const tx = submit({ kind: Win, referenceExternalTransactionId: "ext-bet" });
    tx.markProcessed({
      referenceTransactionId: "tx-bet",
      balanceAfter: brl("50.00"),
      at: T1,
    });

    expect(tx.status).toBe(Processed);
    expect(tx.referenceTransactionId).toBe("tx-bet");
    expect(tx.balanceAfter?.toString()).toBe("50.00");
    expect(tx.processedAt).toEqual(T1);
    expect(tx.failureCode).toBeUndefined();
  });

  it("D14.6 D3.5: reject grava código e saldo observado, sem processedAt nem referência interna", () => {
    const tx = submit();
    tx.reject(FailureCode.InsufficientFunds, { balanceAfter: brl("3.00") });

    expect(tx.status).toBe(Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.balanceAfter?.toString()).toBe("3.00");
    expect(tx.processedAt).toBeUndefined();
    expect(tx.referenceTransactionId).toBeUndefined();
    expect(tx.failureDetail).toBeUndefined();
  });

  it("D14.3: REFERENCE_SCOPE_MISMATCH exige detail, e só ele aceita detail", () => {
    const withDetail = submit({
      kind: Win,
      referenceExternalTransactionId: "ext-bet",
    });
    withDetail.reject(FailureCode.ReferenceScopeMismatch, {
      balanceAfter: brl("1.00"),
      detail: ReferenceScopeField.Round,
    });
    expect(withDetail.failureDetail).toBe(ReferenceScopeField.Round);

    expect(() =>
      submit({ kind: Win, referenceExternalTransactionId: "ext-bet" }).reject(
        FailureCode.ReferenceScopeMismatch,
        { balanceAfter: brl("1.00") },
      ),
    ).toThrow(InvalidTransactionStateError);
    expect(() =>
      submit().reject(FailureCode.InsufficientFunds, {
        balanceAfter: brl("1.00"),
        detail: ReferenceScopeField.Player,
      }),
    ).toThrow(InvalidTransactionStateError);
  });

  it("D14.1: reject não aceita PROCESSING_FAILED e fail só aceita PROCESSING_FAILED", () => {
    expect(() =>
      submit().reject(FailureCode.ProcessingFailed, {
        balanceAfter: brl("1.00"),
      }),
    ).toThrow(InvalidTransactionStateError);

    const pending = submit({ kind: Win, referenceExternalTransactionId: "x" });
    pending.markPendingReference();
    expect(() => pending.fail(FailureCode.ReferenceNotFound)).toThrow(
      InvalidTransactionStateError,
    );
    pending.fail(FailureCode.ProcessingFailed);
    expect(pending.status).toBe(Failed);
    expect(pending.failureCode).toBe(FailureCode.ProcessingFailed);
  });

  it("D7.3 D14.6: markProcessed sem referência interna em transação que tem referência externa lança", () => {
    const tx = submit({ kind: Refund, referenceExternalTransactionId: "x" });
    expect(() =>
      tx.markProcessed({ balanceAfter: brl("1.00"), at: T1 }),
    ).toThrow(InvalidTransactionStateError);
  });

  it("D7.3 D14.6: markProcessed com referência interna em transação sem referência externa lança", () => {
    expect(() =>
      submit({ kind: Win }).markProcessed({
        referenceTransactionId: "tx-bet",
        balanceAfter: brl("1.00"),
        at: T1,
      }),
    ).toThrow(InvalidTransactionStateError);
  });

  it("R-07-13: markPendingReference sem referência externa lança", () => {
    expect(() => submit({ kind: Win }).markPendingReference()).toThrow(
      InvalidTransactionStateError,
    );
  });

  it("R-06-03: rehydrate reconstrói estado terminal sem revalidar", () => {
    const tx = inState(Rejected);
    expect(tx.status).toBe(Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
  });
});

describe("WagerTransaction: consultas de domínio (R-06-35)", () => {
  it("R-06-35 R-07-03: affectsBalance é false só para LOSS", () => {
    expect(submit({ kind: Loss }).affectsBalance()).toBe(false);
    expect(submit({ kind: Bet }).affectsBalance()).toBe(true);
    expect(submit({ kind: Win }).affectsBalance()).toBe(true);
    expect(
      submit({
        kind: Refund,
        referenceExternalTransactionId: "x",
      }).affectsBalance(),
    ).toBe(true);
  });

  it("R-06-35 D1.5: requiresReference é true só para REFUND e ROLLBACK", () => {
    expect(
      submit({
        kind: Refund,
        referenceExternalTransactionId: "x",
      }).requiresReference(),
    ).toBe(true);
    expect(
      submit({
        kind: Rollback,
        referenceExternalTransactionId: "x",
      }).requiresReference(),
    ).toBe(true);
    expect(submit({ kind: Bet }).requiresReference()).toBe(false);
    expect(submit({ kind: Win }).requiresReference()).toBe(false);
    expect(submit({ kind: Loss }).requiresReference()).toBe(false);
  });

  it("R-07-01 R-07-02 R-07-04: BET debita; WIN e REFUND creditam", () => {
    expect(submit({ kind: Bet }).ledgerDirectionFor()).toBe(
      LedgerDirection.Debit,
    );
    expect(submit({ kind: Win }).ledgerDirectionFor()).toBe(
      LedgerDirection.Credit,
    );
    expect(
      submit({
        kind: Refund,
        referenceExternalTransactionId: "x",
      }).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Credit);
  });

  it("R-07-05 D1.2: ROLLBACK inverte a direção da referência", () => {
    const rollback = submit({
      kind: Rollback,
      referenceExternalTransactionId: "x",
    });
    const refund = submit({
      kind: Refund,
      referenceExternalTransactionId: "y",
    });

    expect(rollback.ledgerDirectionFor(submit({ kind: Bet }))).toBe(
      LedgerDirection.Credit,
    );
    expect(rollback.ledgerDirectionFor(submit({ kind: Win }))).toBe(
      LedgerDirection.Debit,
    );
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
  });

  it("R-07-03: LOSS não tem direção; ROLLBACK sem referência não tem direção", () => {
    expect(() => submit({ kind: Loss }).ledgerDirectionFor()).toThrow(
      InvalidTransactionStateError,
    );
    expect(() =>
      submit({
        kind: Rollback,
        referenceExternalTransactionId: "x",
      }).ledgerDirectionFor(),
    ).toThrow(InvalidTransactionStateError);
  });

  it("R-06-39 R-13-U5 D3.3: matchesPayload distingue replay de conflito", () => {
    const tx = submit({ payloadHash: "a".repeat(64) });

    expect(tx.matchesPayload("a".repeat(64))).toBe(true);
    expect(tx.matchesPayload("b".repeat(64))).toBe(false);
  });

  it("R-06-39 D14.5: OPENING nunca casa com payload de submissão", () => {
    const opening = WagerTransaction.opening({
      id: "tx-open",
      walletId: "wallet-1",
      playerId: "player-1",
      money: brl("1.00"),
      createdAt: T0,
    });
    expect(opening.matchesPayload("")).toBe(false);
  });
});

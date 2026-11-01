import { beforeEach, describe, expect, it } from "bun:test";
import fc from "fast-check";
import {
  InvalidTransactionStateError,
  InvalidWalletOperationError,
} from "../../../src/modules/wagering/domain/domain-error";
import {
  FailureCode,
  ReferenceScopeField,
} from "../../../src/modules/wagering/domain/failure-code";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../src/modules/wagering/domain/wager-transaction";
import {
  applyWagerTransaction,
  expirePendingReference,
  openWallet,
} from "../../../src/modules/wagering/domain/wager-transaction-rules";
import { LedgerDirection } from "../../../src/modules/wagering/domain/wallet-ledger-entry";
import { InMemoryBook } from "../../support/in-memory-book";
import { expectLedgerMatchesBalances } from "../../support/ledger-invariant";
import { brl, submissionProps, T0, usd } from "../../support/wager-fixtures";

const { Bet, Win, Loss, Refund, Rollback, Opening } = WagerTransactionKind;
const { Processed, Rejected, PendingReference, Failed } =
  WagerTransactionStatus;

let book: InMemoryBook;

beforeEach(() => {
  book = new InMemoryBook();
  book.openWallet("wallet-1", "player-1", brl("100.00"));
});

const balance = (walletId = "wallet-1") =>
  book.wallet(walletId).balance.toString();
const version = (walletId = "wallet-1") => book.wallet(walletId).version;

function bet(amount: string, externalTransactionId: string) {
  return book.submit({ kind: Bet, money: brl(amount), externalTransactionId });
}

function expectRejected(
  result: ReturnType<InMemoryBook["submit"]>,
  code: FailureCode,
  detail?: ReferenceScopeField,
) {
  expect(result.outcome).toEqual(
    detail
      ? { status: Rejected, failureCode: code, failureDetail: detail }
      : { status: Rejected, failureCode: code },
  );
  expect(result.tx.status).toBe(Rejected);
  expect(result.tx.failureCode).toBe(code);
  expect(result.tx.failureDetail).toBe(detail);
}

describe("openWallet (D6.1, D6.2, D14.5)", () => {
  it("R-06-27 D6.2: com saldo → OPENING PROCESSED, lançamento version 1, wallet version 1", () => {
    const { wallet, opening } = openWallet({
      walletId: "wallet-9",
      playerId: "player-9",
      initialBalance: brl("1000.00"),
      openingTransactionId: "tx-open",
      openingEntryId: "entry-open",
      at: T0,
    });

    expect(wallet.version).toBe(1);
    expect(opening?.transaction.kind).toBe(Opening);
    expect(opening?.transaction.status).toBe(Processed);
    expect(opening?.transaction.walletId).toBe("wallet-9");
    expect(opening?.transaction.balanceAfter?.toString()).toBe("1000.00");
    expect(opening?.transaction.processedAt).toEqual(T0);
    expect(opening?.entry.transactionId).toBe("tx-open");
    expect(opening?.entry.walletVersion).toBe(1);
    expectLedgerMatchesBalances({
      wallet,
      entries: opening ? [opening.entry] : [],
    });
  });

  it("D2.3: com 0 → sem OPENING e sem lançamento", () => {
    const { wallet, opening } = openWallet({
      walletId: "wallet-9",
      playerId: "player-9",
      initialBalance: brl("0"),
      openingTransactionId: "tx-open",
      openingEntryId: "entry-open",
      at: T0,
    });

    expect(opening).toBeUndefined();
    expect(wallet.version).toBe(1);
    expectLedgerMatchesBalances({ wallet, entries: [] });
  });
});

describe("Regras por kind (R-13-U3, D4.1)", () => {
  it("R-07-01: BET debita, gera 1 DEBIT e grava o saldo observado", () => {
    const { tx, outcome } = bet("30.00", "bet-1");

    expect(outcome.status).toBe(Processed);
    expect(
      outcome.status === Processed ? outcome.entry?.direction : undefined,
    ).toBe(LedgerDirection.Debit);
    expect(tx.status).toBe(Processed);
    expect(tx.balanceAfter?.toString()).toBe("70.00");
    expect(tx.processedAt).toEqual(T0);
    expect(balance()).toBe("70.00");
    expect(version()).toBe(2);
    expectLedgerMatchesBalances(...book.books());
  });

  it("R-07-01 R-07-11: BET sem saldo → INSUFFICIENT_FUNDS, sem lançamento e sem mudar version", () => {
    const result = bet("100.01", "bet-1");

    expectRejected(result, FailureCode.InsufficientFunds);
    expect(result.tx.balanceAfter?.toString()).toBe("100.00");
    expect(balance()).toBe("100.00");
    expect(version()).toBe(1);
    expectLedgerMatchesBalances(...book.books());
  });

  it("R-07-02: WIN sem referência credita e gera 1 CREDIT", () => {
    const { tx, outcome } = book.submit({ kind: Win, money: brl("40.00") });

    expect(outcome.status).toBe(Processed);
    expect(
      outcome.status === Processed ? outcome.entry?.direction : undefined,
    ).toBe(LedgerDirection.Credit);
    expect(tx.referenceTransactionId).toBeUndefined();
    expect(balance()).toBe("140.00");
    expectLedgerMatchesBalances(...book.books());
  });

  it("R-07-02 D1.5: WIN referenciando a BET da mesma rodada credita e grava a referência interna", () => {
    const placed = bet("10.00", "bet-1");
    const { tx, outcome } = book.submit({
      kind: Win,
      money: brl("25.00"),
      referenceExternalTransactionId: "bet-1",
    });

    expect(outcome.status).toBe(Processed);
    expect(tx.referenceTransactionId).toBe(placed.tx.id);
    expect(balance()).toBe("115.00");
    expectLedgerMatchesBalances(...book.books());
  });

  it("R-07-03 R-06-43: LOSS é PROCESSED sem lançamento e sem mudar version", () => {
    bet("10.00", "bet-1");
    const { tx, outcome } = book.submit({
      kind: Loss,
      money: brl("0"),
      referenceExternalTransactionId: "bet-1",
    });

    expect(outcome).toEqual({ status: Processed, entry: undefined });
    expect(tx.status).toBe(Processed);
    expect(tx.balanceAfter?.toString()).toBe("90.00");
    expect(balance()).toBe("90.00");
    expect(version()).toBe(2);
    expectLedgerMatchesBalances(...book.books());
  });

  it("R-07-04: REFUND de BET PROCESSED credita o valor da aposta", () => {
    const placed = bet("30.00", "bet-1");
    const { tx, outcome } = book.submit({
      kind: Refund,
      money: brl("30.00"),
      referenceExternalTransactionId: "bet-1",
    });

    expect(outcome.status).toBe(Processed);
    expect(tx.referenceTransactionId).toBe(placed.tx.id);
    expect(balance()).toBe("100.00");
    expect(version()).toBe(3);
    expectLedgerMatchesBalances(...book.books());
  });

  it.each([
    [Bet, LedgerDirection.Credit, "100.00"],
    [Win, LedgerDirection.Debit, "100.00"],
  ] as const)(
    "R-07-05: ROLLBACK de %s gera o lançamento inverso (%s)",
    (kind, direction, finalBalance) => {
      book.submit({
        kind,
        money: brl("15.00"),
        externalTransactionId: "ref-1",
      });
      const { outcome } = book.submit({
        kind: Rollback,
        money: brl("15.00"),
        referenceExternalTransactionId: "ref-1",
      });

      expect(outcome.status).toBe(Processed);
      expect(
        outcome.status === Processed ? outcome.entry?.direction : undefined,
      ).toBe(direction);
      expect(balance()).toBe(finalBalance);
      expectLedgerMatchesBalances(...book.books());
    },
  );
});

describe("Reversões (D1)", () => {
  it("D1.1 R-07-09: REFUND e depois ROLLBACK da mesma BET → REFERENCE_ALREADY_REVERSED", () => {
    bet("30.00", "bet-1");
    book.submit({
      kind: Refund,
      money: brl("30.00"),
      referenceExternalTransactionId: "bet-1",
    });
    const second = book.submit({
      kind: Rollback,
      money: brl("30.00"),
      referenceExternalTransactionId: "bet-1",
    });

    expectRejected(second, FailureCode.ReferenceAlreadyReversed);
    expect(balance()).toBe("100.00");
    expectLedgerMatchesBalances(...book.books());
  });

  it("D1.1 R-07-04: dois REFUNDs da mesma BET → o segundo é REFERENCE_ALREADY_REVERSED", () => {
    bet("30.00", "bet-1");
    const refund = () =>
      book.submit({
        kind: Refund,
        money: brl("30.00"),
        referenceExternalTransactionId: "bet-1",
      });
    expect(refund().outcome.status).toBe(Processed);
    expectRejected(refund(), FailureCode.ReferenceAlreadyReversed);
    expect(balance()).toBe("100.00");
    expectLedgerMatchesBalances(...book.books());
  });

  it("D1.2: ROLLBACK de REFUND debita; depois a BET não pode ser revertida de novo", () => {
    bet("30.00", "bet-1");
    book.submit({
      kind: Refund,
      money: brl("30.00"),
      externalTransactionId: "refund-1",
      referenceExternalTransactionId: "bet-1",
    });
    const rollback = book.submit({
      kind: Rollback,
      money: brl("30.00"),
      referenceExternalTransactionId: "refund-1",
    });

    expect(rollback.outcome.status).toBe(Processed);
    expect(
      rollback.outcome.status === Processed
        ? rollback.outcome.entry?.direction
        : undefined,
    ).toBe(LedgerDirection.Debit);
    expect(balance()).toBe("70.00");

    const again = book.submit({
      kind: Rollback,
      money: brl("30.00"),
      referenceExternalTransactionId: "bet-1",
    });
    expectRejected(again, FailureCode.ReferenceAlreadyReversed);
    expect(balance()).toBe("70.00");
    expectLedgerMatchesBalances(...book.books());
  });

  it("D1.2 R-07-14: ROLLBACK de REFUND sem saldo → INSUFFICIENT_FUNDS_FOR_REVERSAL", () => {
    bet("30.00", "bet-1");
    book.submit({
      kind: Refund,
      money: brl("30.00"),
      externalTransactionId: "refund-1",
      referenceExternalTransactionId: "bet-1",
    });
    bet("95.00", "bet-2");
    const rollback = book.submit({
      kind: Rollback,
      money: brl("30.00"),
      referenceExternalTransactionId: "refund-1",
    });

    expectRejected(rollback, FailureCode.InsufficientFundsForReversal);
    expect(rollback.tx.balanceAfter?.toString()).toBe("5.00");
    expect(balance()).toBe("5.00");
    expectLedgerMatchesBalances(...book.books());
  });

  it("R-07-14: ROLLBACK de WIN sem saldo → INSUFFICIENT_FUNDS_FOR_REVERSAL (distinto de INSUFFICIENT_FUNDS)", () => {
    book.submit({
      kind: Win,
      money: brl("50.00"),
      externalTransactionId: "win-1",
    });
    bet("140.00", "bet-1");
    const rollback = book.submit({
      kind: Rollback,
      money: brl("50.00"),
      referenceExternalTransactionId: "win-1",
    });

    expectRejected(rollback, FailureCode.InsufficientFundsForReversal);
    expect(FailureCode.InsufficientFundsForReversal).not.toBe(
      FailureCode.InsufficientFunds,
    );
    expectLedgerMatchesBalances(...book.books());
  });

  it("D1.3: reversão REJECTED não bloqueia uma nova tentativa (com outro id)", () => {
    book.submit({
      kind: Win,
      money: brl("50.00"),
      externalTransactionId: "win-1",
    });
    const spend = bet("140.00", "bet-1");
    const first = book.submit({
      kind: Rollback,
      money: brl("50.00"),
      referenceExternalTransactionId: "win-1",
    });
    expectRejected(first, FailureCode.InsufficientFundsForReversal);

    book.submit({
      kind: Refund,
      money: brl("140.00"),
      referenceExternalTransactionId: spend.tx.externalTransactionId,
    });
    const retry = book.submit({
      kind: Rollback,
      money: brl("50.00"),
      referenceExternalTransactionId: "win-1",
    });

    expect(retry.outcome.status).toBe(Processed);
    expect(balance()).toBe("100.00");
    expectLedgerMatchesBalances(...book.books());
  });

  it("R-07-10: REFUND com valor diferente da BET → AMOUNT_MISMATCH", () => {
    bet("30.00", "bet-1");
    const refund = book.submit({
      kind: Refund,
      money: brl("29.99"),
      referenceExternalTransactionId: "bet-1",
    });

    expectRejected(refund, FailureCode.AmountMismatch);
    expect(balance()).toBe("70.00");
    expectLedgerMatchesBalances(...book.books());
  });

  it("R-07-10: ROLLBACK com valor diferente → AMOUNT_MISMATCH", () => {
    bet("30.00", "bet-1");
    expectRejected(
      book.submit({
        kind: Rollback,
        money: brl("30.01"),
        referenceExternalTransactionId: "bet-1",
      }),
      FailureCode.AmountMismatch,
    );
    expectLedgerMatchesBalances(...book.books());
  });
});

describe("Tipo da referência (R-07-08, D1.5)", () => {
  it.each([
    [Refund, Win],
    [Refund, Loss],
    [Refund, Refund],
    [Refund, Rollback],
    [Rollback, Loss],
    [Rollback, Rollback],
    [Win, Win],
    [Win, Refund],
    [Loss, Win],
    [Loss, Loss],
  ] as const)(
    "%s referenciando %s → REFERENCE_KIND_NOT_ALLOWED",
    (kind, referenceKind) => {
      bet("10.00", "bet-1");
      const needsRef = referenceKind === Refund || referenceKind === Rollback;
      book.submit({
        kind: referenceKind,
        money: brl("10.00"),
        externalTransactionId: "ref-1",
        referenceExternalTransactionId: needsRef ? "bet-1" : undefined,
      });

      const result = book.submit({
        kind,
        money: brl("10.00"),
        referenceExternalTransactionId: "ref-1",
      });

      expectRejected(result, FailureCode.ReferenceKindNotAllowed);
      expectLedgerMatchesBalances(...book.books());
    },
  );

  it("R-07-08: ROLLBACK aceita BET, WIN e REFUND como referência", () => {
    bet("10.00", "bet-1");
    bet("10.00", "bet-2");
    book.submit({
      kind: Win,
      money: brl("5.00"),
      externalTransactionId: "win-1",
    });
    book.submit({
      kind: Refund,
      money: brl("10.00"),
      externalTransactionId: "refund-1",
      referenceExternalTransactionId: "bet-2",
    });

    for (const [ref, amount] of [
      ["bet-1", "10.00"],
      ["win-1", "5.00"],
      ["refund-1", "10.00"],
    ] as const) {
      const result = book.submit({
        kind: Rollback,
        money: brl(amount),
        referenceExternalTransactionId: ref,
      });
      expect(result.outcome.status).toBe(Processed);
    }
    expectLedgerMatchesBalances(...book.books());
  });
});

describe("Estado da referência (D1.4, R-07-13)", () => {
  it("R-07-13: referência ausente → PENDING_REFERENCE, sem saldo e sem lançamento", () => {
    const { tx, outcome } = book.submit({
      kind: Refund,
      money: brl("10.00"),
      referenceExternalTransactionId: "bet-later",
    });

    expect(outcome).toEqual({ status: PendingReference, transitioned: true });
    expect(tx.status).toBe(PendingReference);
    expect(tx.balanceAfter).toBeUndefined();
    expect(balance()).toBe("100.00");
    expectLedgerMatchesBalances(...book.books());
  });

  it("R-07-13 D4.5 D4.6: pendente reavaliada sem referência continua pendente, sem nova transição", () => {
    const { tx } = book.submit({
      kind: Refund,
      money: brl("10.00"),
      referenceExternalTransactionId: "bet-later",
    });

    expect(book.retry(tx)).toEqual({
      status: PendingReference,
      transitioned: false,
    });
    expect(tx.status).toBe(PendingReference);
  });

  it("D3.4 D4.5: REFUND já REJECTED (REFERENCE_NOT_FOUND) reaplicada com a referência ainda ausente lança, não volta a PENDING_REFERENCE", () => {
    const { tx } = book.submit({
      kind: Refund,
      money: brl("10.00"),
      referenceExternalTransactionId: "bet-never",
    });
    tx.reject(FailureCode.ReferenceNotFound, {
      balanceAfter: book.wallet().balance,
    });

    expect(() => book.retry(tx)).toThrow(InvalidTransactionStateError);
    expect(tx.status).toBe(Rejected);
    expect(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(balance()).toBe("100.00");
    expectLedgerMatchesBalances(...book.books());
  });

  it("R-07-13 R-13-C7: REFUND chega antes da BET; depois da BET o reprocessamento aplica", () => {
    const { tx } = book.submit({
      kind: Refund,
      money: brl("10.00"),
      referenceExternalTransactionId: "bet-later",
    });
    const placed = bet("10.00", "bet-later");

    expect(book.retry(tx).status).toBe(Processed);
    expect(tx.status).toBe(Processed);
    expect(tx.referenceTransactionId).toBe(placed.tx.id);
    expect(balance()).toBe("100.00");
    expectLedgerMatchesBalances(...book.books());
  });

  it("D1.4: referência ainda PENDING_REFERENCE → a transação também espera", () => {
    book.submit({
      kind: Refund,
      money: brl("10.00"),
      externalTransactionId: "refund-1",
      referenceExternalTransactionId: "bet-later",
    });
    const rollback = book.submit({
      kind: Rollback,
      money: brl("10.00"),
      referenceExternalTransactionId: "refund-1",
    });

    expect(rollback.outcome).toEqual({
      status: PendingReference,
      transitioned: true,
    });
    expectLedgerMatchesBalances(...book.books());
  });

  it("D1.4: WIN de BET rejeitada → REFERENCE_NOT_PROCESSED (não cria dinheiro)", () => {
    expect(bet("500.00", "bet-1").outcome.status).toBe(Rejected);
    const win = book.submit({
      kind: Win,
      money: brl("1000.00"),
      referenceExternalTransactionId: "bet-1",
    });

    expectRejected(win, FailureCode.ReferenceNotProcessed);
    expect(balance()).toBe("100.00");
    expectLedgerMatchesBalances(...book.books());
  });

  it.each([Refund, Rollback, Loss])(
    "D1.4: %s de BET rejeitada → REFERENCE_NOT_PROCESSED",
    (kind) => {
      bet("500.00", "bet-1");
      expectRejected(
        book.submit({
          kind,
          money: brl("500.00"),
          referenceExternalTransactionId: "bet-1",
        }),
        FailureCode.ReferenceNotProcessed,
      );
      expectLedgerMatchesBalances(...book.books());
    },
  );

  it("D1.4 D4.2: referência FAILED → REFERENCE_NOT_PROCESSED", () => {
    const { tx: refund } = book.submit({
      kind: Refund,
      money: brl("10.00"),
      externalTransactionId: "refund-1",
      referenceExternalTransactionId: "bet-never",
    });
    refund.fail(FailureCode.ProcessingFailed);
    expect(refund.status).toBe(Failed);

    expectRejected(
      book.submit({
        kind: Rollback,
        money: brl("10.00"),
        referenceExternalTransactionId: "refund-1",
      }),
      FailureCode.ReferenceNotProcessed,
    );
    expectLedgerMatchesBalances(...book.books());
  });

  it("D1.6 D14.9: WIN depois de REFUND da mesma BET é aceito, sem conferir valor", () => {
    bet("30.00", "bet-1");
    book.submit({
      kind: Refund,
      money: brl("30.00"),
      referenceExternalTransactionId: "bet-1",
    });
    const win = book.submit({
      kind: Win,
      money: brl("75.00"),
      referenceExternalTransactionId: "bet-1",
    });

    expect(win.outcome.status).toBe(Processed);
    expect(balance()).toBe("175.00");
    expectLedgerMatchesBalances(...book.books());
  });

  it("D1.6: REFUND depois de WIN da mesma BET é aceito", () => {
    bet("30.00", "bet-1");
    book.submit({
      kind: Win,
      money: brl("60.00"),
      referenceExternalTransactionId: "bet-1",
    });
    const refund = book.submit({
      kind: Refund,
      money: brl("30.00"),
      referenceExternalTransactionId: "bet-1",
    });

    expect(refund.outcome.status).toBe(Processed);
    expect(balance()).toBe("160.00");
    expectLedgerMatchesBalances(...book.books());
  });
});

describe("Escopo da referência (R-07-07, D14.3)", () => {
  beforeEach(() => {
    book.openWallet("wallet-2", "player-2", brl("100.00"));
    book.openWallet("wallet-3", "player-1", usd("100.00"));
  });

  it("R-07-07 D14.3: referência de outro player → REFERENCE_SCOPE_MISMATCH(PLAYER)", () => {
    book.submit({
      kind: Bet,
      walletId: "wallet-2",
      playerId: "player-2",
      money: brl("10.00"),
      externalTransactionId: "bet-p2",
    });
    const refund = book.submit({
      kind: Refund,
      money: brl("10.00"),
      referenceExternalTransactionId: "bet-p2",
    });

    expectRejected(
      refund,
      FailureCode.ReferenceScopeMismatch,
      ReferenceScopeField.Player,
    );
    expect(refund.tx.referenceTransactionId).toBeUndefined();
    expectLedgerMatchesBalances(...book.books());
  });

  it("R-07-07 D14.3: referência de outra wallet do mesmo player → REFERENCE_SCOPE_MISMATCH(WALLET)", () => {
    book.submit({
      kind: Bet,
      walletId: "wallet-3",
      money: usd("10.00"),
      externalTransactionId: "bet-usd",
    });
    expectRejected(
      book.submit({
        kind: Refund,
        money: brl("10.00"),
        referenceExternalTransactionId: "bet-usd",
      }),
      FailureCode.ReferenceScopeMismatch,
      ReferenceScopeField.Wallet,
    );
    expectLedgerMatchesBalances(...book.books());
  });

  it("R-07-07 D14.3: referência na mesma wallet com outra moeda → REFERENCE_SCOPE_MISMATCH(CURRENCY)", () => {
    // Estado que o banco impede (FK composta, D7.3); o domínio confere mesmo assim.
    book.store(
      WagerTransaction.rehydrate({
        ...submissionProps({
          kind: Bet,
          money: usd("10.00"),
          externalTransactionId: "bet-odd",
        }),
        status: Processed,
        referenceTransactionId: undefined,
        failureCode: undefined,
        failureDetail: undefined,
        balanceAfter: usd("90.00"),
        processedAt: T0,
      }),
    );
    expectRejected(
      book.submit({
        kind: Refund,
        money: brl("10.00"),
        referenceExternalTransactionId: "bet-odd",
      }),
      FailureCode.ReferenceScopeMismatch,
      ReferenceScopeField.Currency,
    );
    expectLedgerMatchesBalances(...book.books());
  });

  it("R-07-07 D14.3: referência de outra rodada → REFERENCE_SCOPE_MISMATCH(ROUND)", () => {
    book.submit({
      kind: Bet,
      money: brl("10.00"),
      roundId: "round-other",
      externalTransactionId: "bet-r2",
    });
    expectRejected(
      book.submit({
        kind: Win,
        money: brl("10.00"),
        referenceExternalTransactionId: "bet-r2",
      }),
      FailureCode.ReferenceScopeMismatch,
      ReferenceScopeField.Round,
    );
    expectLedgerMatchesBalances(...book.books());
  });

  it("R-07-07: referência de outro provedor não é encontrada → PENDING_REFERENCE", () => {
    bet("10.00", "bet-1");
    const refund = book.submit({
      kind: Refund,
      providerId: "provider-2",
      money: brl("10.00"),
      referenceExternalTransactionId: "bet-1",
    });

    expect(refund.outcome.status).toBe(PendingReference);
    expectLedgerMatchesBalances(...book.books());
  });
});

describe("Wallet e moeda (R-06-26, R-13-U4, D5)", () => {
  it("R-06-26 R-13-U4: BET em USD numa wallet BRL → CURRENCY_MISMATCH, sem lançamento", () => {
    const result = book.submit({ kind: Bet, money: usd("10.00") });

    expectRejected(result, FailureCode.CurrencyMismatch);
    expect(result.tx.balanceAfter?.toString()).toBe("100.00");
    expect(balance()).toBe("100.00");
    expectLedgerMatchesBalances(...book.books());
  });

  it("D5: wallet de outro playerId → WALLET_PLAYER_MISMATCH", () => {
    expectRejected(
      book.submit({ kind: Bet, playerId: "player-x" }),
      FailureCode.WalletPlayerMismatch,
    );
    expectLedgerMatchesBalances(...book.books());
  });

  it("D2.4: crédito acima do teto de 15 dígitos → BALANCE_LIMIT_EXCEEDED", () => {
    const rich = book.openWallet(
      "wallet-rich",
      "player-rich",
      brl("999999999999.99"),
    );
    // Sobe até perto do teto com WINs de 12 dígitos.
    for (let i = 0; i < 999; i++) {
      book.submit({
        kind: Win,
        walletId: "wallet-rich",
        playerId: "player-rich",
        money: brl("999999999999.99"),
      });
    }
    const before = rich.balance.toString();
    const over = book.submit({
      kind: Win,
      walletId: "wallet-rich",
      playerId: "player-rich",
      money: brl("999999999999.99"),
    });

    expect(before).toBe("999999999999990.00");
    expectRejected(over, FailureCode.BalanceLimitExceeded);
    expect(rich.balance.toString()).toBe(before);
    expectLedgerMatchesBalances(...book.books());
  });

  it("D6.5: transação de outra wallet é erro de programação", () => {
    const { wallet } = openWallet({
      walletId: "wallet-x",
      playerId: "player-1",
      initialBalance: brl("1.00"),
      openingTransactionId: "o",
      openingEntryId: "e",
      at: T0,
    });
    expect(() =>
      applyWagerTransaction({
        wallet,
        transaction: WagerTransaction.create(submissionProps()),
        reference: undefined,
        entryId: "entry-x",
        at: T0,
      }),
    ).toThrow(InvalidWalletOperationError);
  });
});

describe("Ordem das checagens (D14.2)", () => {
  it("D14.2 1 antes de 2: player e moeda errados → WALLET_PLAYER_MISMATCH", () => {
    expectRejected(
      book.submit({ kind: Bet, playerId: "player-x", money: usd("1.00") }),
      FailureCode.WalletPlayerMismatch,
    );
  });

  it("D14.2 2 antes de 3: moeda errada e referência ausente → CURRENCY_MISMATCH (não espera)", () => {
    expectRejected(
      book.submit({
        kind: Refund,
        money: usd("1.00"),
        referenceExternalTransactionId: "missing",
      }),
      FailureCode.CurrencyMismatch,
    );
  });

  it("D14.2 4 antes de 6: escopo errado e referência pendente → REFERENCE_SCOPE_MISMATCH (não espera)", () => {
    book.submit({
      kind: Refund,
      money: brl("10.00"),
      roundId: "round-other",
      externalTransactionId: "refund-pending",
      referenceExternalTransactionId: "bet-later",
    });
    expectRejected(
      book.submit({
        kind: Rollback,
        money: brl("10.00"),
        referenceExternalTransactionId: "refund-pending",
      }),
      FailureCode.ReferenceScopeMismatch,
      ReferenceScopeField.Round,
    );
  });

  it("D14.2 4 antes de 5: escopo e tipo errados → REFERENCE_SCOPE_MISMATCH", () => {
    book.submit({
      kind: Win,
      money: brl("10.00"),
      roundId: "round-other",
      externalTransactionId: "win-r2",
    });
    expectRejected(
      book.submit({
        kind: Refund,
        money: brl("10.00"),
        referenceExternalTransactionId: "win-r2",
      }),
      FailureCode.ReferenceScopeMismatch,
      ReferenceScopeField.Round,
    );
    expectLedgerMatchesBalances(...book.books());
  });

  it("D14.2 5 antes de 6: tipo errado e referência rejeitada → REFERENCE_KIND_NOT_ALLOWED", () => {
    bet("500.00", "bet-rejected");
    const win = book.submit({
      kind: Win,
      money: brl("10.00"),
      externalTransactionId: "win-rejected",
      referenceExternalTransactionId: "bet-rejected",
    });
    expect(win.tx.status).toBe(Rejected);

    expectRejected(
      book.submit({
        kind: Refund,
        money: brl("10.00"),
        referenceExternalTransactionId: "win-rejected",
      }),
      FailureCode.ReferenceKindNotAllowed,
    );
    expectLedgerMatchesBalances(...book.books());
  });

  it("D14.2 6 antes de 7 e 8: referência rejeitada e valor errado → REFERENCE_NOT_PROCESSED", () => {
    bet("500.00", "bet-rejected");
    expectRejected(
      book.submit({
        kind: Refund,
        money: brl("1.00"),
        referenceExternalTransactionId: "bet-rejected",
      }),
      FailureCode.ReferenceNotProcessed,
    );
  });

  it("D14.2 7 antes de 8: já revertida e valor errado → REFERENCE_ALREADY_REVERSED", () => {
    bet("30.00", "bet-1");
    book.submit({
      kind: Refund,
      money: brl("30.00"),
      referenceExternalTransactionId: "bet-1",
    });
    expectRejected(
      book.submit({
        kind: Rollback,
        money: brl("1.00"),
        referenceExternalTransactionId: "bet-1",
      }),
      FailureCode.ReferenceAlreadyReversed,
    );
    expectLedgerMatchesBalances(...book.books());
  });

  it("D14.2 8 antes de 9: valor errado e sem saldo → AMOUNT_MISMATCH", () => {
    book.submit({
      kind: Win,
      money: brl("50.00"),
      externalTransactionId: "win-1",
    });
    bet("150.00", "bet-1");
    expectRejected(
      book.submit({
        kind: Rollback,
        money: brl("49.00"),
        referenceExternalTransactionId: "win-1",
      }),
      FailureCode.AmountMismatch,
    );
    expectLedgerMatchesBalances(...book.books());
  });
});

describe("Invariante sob qualquer sequência (propriedade)", () => {
  const amount = fc
    .bigInt({ min: 1n, max: 20_000n })
    .map((c) => `${c / 100n}.${(c % 100n).toString().padStart(2, "0")}`);

  const step = fc.oneof(
    fc.record({ kind: fc.constant(Bet), amount }),
    fc.record({ kind: fc.constant(Win), amount, ref: fc.option(fc.nat(30)) }),
    fc.record({ kind: fc.constant(Loss), amount, ref: fc.option(fc.nat(30)) }),
    fc.record({
      kind: fc.constant(Refund),
      ref: fc.nat(30),
      sameAmount: fc.boolean(),
    }),
    fc.record({
      kind: fc.constant(Rollback),
      ref: fc.nat(30),
      sameAmount: fc.boolean(),
    }),
  );

  it("R-13-U3 R-06-24 D1.1: saldo = Σ lançamentos, saldo ≥ 0 e no máximo uma reversão PROCESSED por referência", () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
        book = new InMemoryBook();
        book.openWallet("wallet-1", "player-1", brl("100.00"));
        const submitted: WagerTransaction[] = [];

        steps.forEach((s, i) => {
          const refTx =
            "ref" in s && s.ref !== null && submitted.length > 0
              ? submitted[s.ref % submitted.length]
              : undefined;
          const money =
            "amount" in s
              ? brl(s.amount)
              : refTx && s.sameAmount
                ? refTx.money
                : brl("0.01");
          const needsRef = s.kind === Refund || s.kind === Rollback;
          const { tx } = book.submit({
            kind: s.kind,
            money,
            externalTransactionId: `p-${i}`,
            referenceExternalTransactionId:
              refTx?.externalTransactionId ??
              (needsRef ? `missing-${i}` : undefined),
          });
          submitted.push(tx);
        });

        const reversed = submitted
          .filter(
            (t) =>
              t.status === Processed &&
              (t.kind === Refund || t.kind === Rollback),
          )
          .map((t) => t.referenceTransactionId);
        expect(new Set(reversed).size).toBe(reversed.length);
        for (const t of submitted) {
          expect(
            t.status === Processed ||
              t.status === Rejected ||
              t.status === PendingReference,
          ).toBe(true);
        }
        expectLedgerMatchesBalances(...book.books());
      }),
      { numRuns: 200 },
    );
  });
});

describe("expirePendingReference (R-07-22, D4.3)", () => {
  it("R-07-22 D4.3: pendente expirada → REJECTED REFERENCE_NOT_FOUND com o saldo atual, sem lançamento", () => {
    const { tx } = book.submit({
      kind: Refund,
      money: brl("10.00"),
      referenceExternalTransactionId: "bet-never",
    });

    const outcome = expirePendingReference(book.wallet(), tx);

    expect(outcome).toEqual({
      status: Rejected,
      failureCode: FailureCode.ReferenceNotFound,
    });
    expect(tx.status).toBe(Rejected);
    expect(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(tx.balanceAfter?.toString()).toBe("100.00");
    expect(balance()).toBe("100.00");
    expect(version()).toBe(1);
    expectLedgerMatchesBalances(...book.books());
  });

  it("D4.5: expirar uma transação que não está PENDING_REFERENCE lança e não muda nada", () => {
    const placed = bet("10.00", "bet-1");
    const fresh = WagerTransaction.create(
      submissionProps({ kind: Refund, referenceExternalTransactionId: "x" }),
    );

    expect(() => expirePendingReference(book.wallet(), placed.tx)).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => expirePendingReference(book.wallet(), fresh)).toThrow(
      InvalidTransactionStateError,
    );
    expect(placed.tx.status).toBe(Processed);
    expect(fresh.status).toBe(WagerTransactionStatus.Pending);
  });

  it("D4.5: pendente de outra wallet → lança", () => {
    book.openWallet("wallet-2", "player-2", brl("50.00"));
    const { tx } = book.submit({
      kind: Refund,
      money: brl("10.00"),
      referenceExternalTransactionId: "bet-never",
    });

    expect(() => expirePendingReference(book.wallet("wallet-2"), tx)).toThrow(
      InvalidWalletOperationError,
    );
    expect(tx.status).toBe(PendingReference);
  });
});

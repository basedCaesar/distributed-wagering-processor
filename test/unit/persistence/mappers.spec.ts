import { describe, expect, it } from "bun:test";
import {
  FailureCode,
  ReferenceScopeField,
} from "../../../src/modules/wagering/domain/failure-code";
import { Money } from "../../../src/modules/wagering/domain/money";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../src/modules/wagering/domain/wager-transaction";
import { Wallet } from "../../../src/modules/wagering/domain/wallet";
import {
  ledgerEntryFromRecord,
  ledgerEntryToRecord,
} from "../../../src/modules/wagering/infra/persistence/wallet-ledger-entry.mapper";
import {
  wagerTransactionFromRecord,
  wagerTransactionToRecord,
} from "../../../src/modules/wagering/infra/persistence/wager-transaction.mapper";
import {
  walletFromRecord,
  walletToRecord,
} from "../../../src/modules/wagering/infra/persistence/wallet.mapper";
import { brl, submit, T0, usd } from "../../support/wager-fixtures";

const T1 = new Date("2026-10-30T12:00:01.000Z");

function openWallet(initial = brl("100.00")) {
  return Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: initial,
    openingTransactionId: "tx-opening",
    openingEntryId: "entry-opening",
    at: T0,
  });
}

/** Estado observável da transação, para comparar domínio × reidratado. */
function snapshot(tx: WagerTransaction) {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    payloadHash: tx.payloadHash,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    referenceExternalTransactionId: tx.referenceExternalTransactionId,
    createdAt: tx.createdAt,
    status: tx.status,
    referenceTransactionId: tx.referenceTransactionId,
    failureCode: tx.failureCode,
    failureDetail: tx.failureDetail,
    balanceAfter: tx.balanceAfter?.toJSON(),
    processedAt: tx.processedAt,
  };
}

function roundTrip(tx: WagerTransaction) {
  return wagerTransactionFromRecord(
    wagerTransactionToRecord(tx, { updatedAt: T1, correlationId: null }),
  );
}

describe("S2 D7.1: mappers domínio ↔ record", () => {
  it("D7.1: Wallet ida e volta preserva saldo, versão e datas", () => {
    // 14 dígitos inteiros: só cabe como saldo (teto de 15, D2.4), não como entrada.
    const { wallet } = openWallet(
      Money.rehydrate({ amount: "90071992547409.93", currency: "BRL" }),
    );

    const back = walletFromRecord(walletToRecord(wallet));

    expect(back.id).toBe(wallet.id);
    expect(back.playerId).toBe(wallet.playerId);
    expect(back.currency).toBe("BRL");
    expect(back.balance.toString()).toBe("90071992547409.93");
    expect(back.version).toBe(1);
    expect(back.createdAt).toEqual(T0);
    expect(back.updatedAt).toEqual(T0);
  });

  it("D7.2: o record da wallet leva a version do domínio, sem incremento", () => {
    const { wallet } = openWallet();
    wallet.debit({
      money: brl("10.00"),
      transactionId: "tx-1",
      entryId: "entry-1",
      at: T1,
    });

    const record = walletToRecord(wallet);

    expect(record.version).toBe(2);
    expect(record.balance).toBe("90.00");
    expect(record.updatedAt).toEqual(T1);
  });

  it("D2.4: o valor vai para o record como string, nunca number", () => {
    const { wallet } = openWallet();

    expect(typeof walletToRecord(wallet).balance).toBe("string");
  });

  it("D7.1: lançamento ida e volta preserva todos os campos", () => {
    const { openingEntry } = openWallet();
    if (!openingEntry) throw new Error("OPENING sem lançamento");

    const back = ledgerEntryFromRecord(ledgerEntryToRecord(openingEntry));

    expect(back).toEqual(openingEntry);
    expect(back.isBalanced()).toBe(true);
  });

  it("D6.1 D14.5: OPENING ida e volta, com os campos do provedor nulos no record", () => {
    const opening = WagerTransaction.opening({
      id: "tx-opening",
      walletId: "wallet-1",
      playerId: "player-1",
      money: brl("100.00"),
      createdAt: T0,
    });
    opening.markProcessed({ balanceAfter: brl("100.00"), at: T0 });

    const record = wagerTransactionToRecord(opening, {
      updatedAt: T0,
      correlationId: null,
    });

    expect(record.providerId).toBeNull();
    expect(record.externalTransactionId).toBeNull();
    expect(record.idempotencyKey).toBeNull();
    expect(record.payloadHash).toBeNull();
    expect(record.roundId).toBeNull();
    expect(record.gameId).toBeNull();
    expect(snapshot(wagerTransactionFromRecord(record))).toEqual(
      snapshot(opening),
    );
  });

  it("D3.5 D14.6: PROCESSED com referência ida e volta", () => {
    const refund = submit({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: "ext-bet",
    });
    refund.markProcessed({
      referenceTransactionId: "tx-bet",
      balanceAfter: brl("110.00"),
      at: T1,
    });

    expect(snapshot(roundTrip(refund))).toEqual(snapshot(refund));
  });

  it("D14.3: REJECTED com failureDetail ida e volta", () => {
    const win = submit({
      kind: WagerTransactionKind.Win,
      referenceExternalTransactionId: "ext-bet",
    });
    win.reject(FailureCode.ReferenceScopeMismatch, {
      balanceAfter: brl("100.00"),
      detail: ReferenceScopeField.Round,
    });

    const back = roundTrip(win);

    expect(back.failureDetail).toBe(ReferenceScopeField.Round);
    expect(snapshot(back)).toEqual(snapshot(win));
  });

  it("D3.5: REJECTED por moeda guarda o saldo na moeda da wallet", () => {
    const bet = submit({ money: usd("10.00") });
    bet.reject(FailureCode.CurrencyMismatch, { balanceAfter: brl("100.00") });

    const record = wagerTransactionToRecord(bet, {
      updatedAt: T1,
      correlationId: null,
    });

    expect(record.currency).toBe("USD");
    expect(record.balanceAfter).toBe("100.00");
    expect(record.balanceAfterCurrency).toBe("BRL");
    expect(snapshot(wagerTransactionFromRecord(record))).toEqual(snapshot(bet));
  });

  it("D4.1: PENDING_REFERENCE ida e volta, sem saldo", () => {
    const refund = submit({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: "ext-missing",
    });
    refund.markPendingReference();

    const record = wagerTransactionToRecord(refund, {
      updatedAt: T1,
      correlationId: null,
    });

    expect(record.balanceAfter).toBeNull();
    expect(record.balanceAfterCurrency).toBeNull();
    expect(roundTrip(refund).status).toBe(
      WagerTransactionStatus.PendingReference,
    );
  });

  it("D4.2 D14.1: FAILED ida e volta", () => {
    const refund = submit({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: "ext-missing",
    });
    refund.markPendingReference();
    refund.fail(FailureCode.ProcessingFailed);

    expect(snapshot(roundTrip(refund))).toEqual(snapshot(refund));
  });

  it("D9.5: o correlationId de quem salva vai para o record, fora da entidade", () => {
    const bet = submit();
    bet.markProcessed({ balanceAfter: brl("90.00"), at: T1 });

    const record = wagerTransactionToRecord(bet, {
      updatedAt: T1,
      correlationId: "corr-1",
    });

    expect(record.correlationId).toBe("corr-1");
    expect(snapshot(wagerTransactionFromRecord(record))).toEqual(snapshot(bet));
  });

  it("D4.1: PENDING não vira record (nunca é gravado)", () => {
    expect(() =>
      wagerTransactionToRecord(submit(), {
        updatedAt: T1,
        correlationId: null,
      }),
    ).toThrow();
  });

  it("D2.3: LOSS de valor zero ida e volta", () => {
    const loss = submit({
      kind: WagerTransactionKind.Loss,
      money: Money.from({ amount: "0", currency: "BRL" }),
    });
    loss.markProcessed({ balanceAfter: brl("100.00"), at: T1 });

    expect(roundTrip(loss).money.toString()).toBe("0.00");
  });
});

import { describe, expect, it } from "bun:test";
import {
  InvalidTransactionStateError,
  InvalidWalletOperationError,
} from "../../../src/modules/wagering/domain/domain-error";
import type { EventContext } from "../../../src/modules/wagering/domain/events/event-context";
import { IntegrationEvent } from "../../../src/modules/wagering/domain/events/integration-event";
import { WagerTransactionFailed } from "../../../src/modules/wagering/domain/events/wager-transaction-failed";
import { WagerTransactionPendingReference } from "../../../src/modules/wagering/domain/events/wager-transaction-pending-reference";
import { WagerTransactionProcessed } from "../../../src/modules/wagering/domain/events/wager-transaction-processed";
import { WagerTransactionRejected } from "../../../src/modules/wagering/domain/events/wager-transaction-rejected";
import { WalletBalanceChanged } from "../../../src/modules/wagering/domain/events/wallet-balance-changed";
import { WalletOpened } from "../../../src/modules/wagering/domain/events/wallet-opened";
import { FailureCode } from "../../../src/modules/wagering/domain/failure-code";
import { WagerTransactionKind } from "../../../src/modules/wagering/domain/wager-transaction";
import { openWallet } from "../../../src/modules/wagering/domain/wager-transaction-rules";
import { InMemoryBook } from "../../support/in-memory-book";
import { brl, T0 } from "../../support/wager-fixtures";

const ctx: EventContext = {
  eventId: "0193f1c2-0000-7000-8000-000000000001",
  correlationId: "corr-1",
  causationId: "msg-1",
  occurredAt: new Date("2026-10-30T12:34:56.789Z"),
};

function processedBet() {
  const book = new InMemoryBook();
  book.openWallet("wallet-1", "player-1", brl("100.00"));
  const { tx, outcome } = book.submit({
    kind: WagerTransactionKind.Bet,
    money: brl("25.00"),
    externalTransactionId: "bet-1",
  });
  const entry = outcome.status === "PROCESSED" ? outcome.entry : undefined;
  if (!entry) throw new Error("BET deveria ter lançamento");
  return { book, tx, entry, wallet: book.wallet() };
}

/** Ida e volta por JSON: o payload tem que ser estável (R-11-12). */
const roundTrip = (event: IntegrationEvent<unknown>) =>
  JSON.parse(JSON.stringify(event));

describe("IntegrationEvent (R-11-08, R-11-09)", () => {
  it("R-11-08: o envelope é uma classe abstrata e cada evento é uma subclasse", () => {
    const { wallet, entry } = processedBet();
    const event = WalletBalanceChanged.from(wallet, entry, ctx);
    expect(event).toBeInstanceOf(IntegrationEvent);
  });

  it("R-11-09: toJSON devolve exatamente o envelope, com occurredAt em ISO-8601", () => {
    const { wallet, entry } = processedBet();
    const json = WalletBalanceChanged.from(wallet, entry, ctx).toJSON();

    expect(Object.keys(json).sort()).toEqual(
      [
        "aggregateId",
        "causationId",
        "correlationId",
        "data",
        "eventId",
        "eventType",
        "occurredAt",
        "version",
      ].sort(),
    );
    expect(json.eventId).toBe(ctx.eventId);
    expect(json.correlationId).toBe("corr-1");
    expect(json.causationId).toBe("msg-1");
    expect(json.occurredAt).toBe("2026-10-30T12:34:56.789Z");
  });

  it("R-11-09: causationId ausente não aparece no envelope", () => {
    const { wallet, entry } = processedBet();
    const json = WalletBalanceChanged.from(wallet, entry, {
      ...ctx,
      causationId: undefined,
    }).toJSON();
    expect("causationId" in json).toBe(false);
  });

  it("R-11-10: eventType e version vêm do tipo", () => {
    const { wallet, entry, tx } = processedBet();
    const balanceChanged = WalletBalanceChanged.from(wallet, entry, ctx);
    const processed = WagerTransactionProcessed.from(tx, entry, ctx);

    expect(balanceChanged.eventType).toBe("WalletBalanceChanged");
    expect(balanceChanged.version).toBe(1);
    expect(balanceChanged.toJSON().eventType).toBe("WalletBalanceChanged");
    expect(processed.eventType).toBe("WagerTransactionProcessed");
    expect(processed.toJSON().version).toBe(1);
  });

  it("R-11-12: o envelope é imutável", () => {
    const { wallet, entry } = processedBet();
    const event = WalletBalanceChanged.from(wallet, entry, ctx);
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.data)).toBe(true);
  });
});

describe("WalletBalanceChanged (R-11-11, R-11-12, D9.3)", () => {
  it("R-11-11: data tem exatamente os campos do enunciado, com MoneyProps", () => {
    const { wallet, entry, tx } = processedBet();
    const json = roundTrip(WalletBalanceChanged.from(wallet, entry, ctx));

    expect(json.aggregateId).toBe("wallet-1");
    expect(json.data).toEqual({
      walletId: "wallet-1",
      transactionId: tx.id,
      direction: "DEBIT",
      money: { amount: "25.00", currency: "BRL" },
      balanceBefore: { amount: "100.00", currency: "BRL" },
      balanceAfter: { amount: "75.00", currency: "BRL" },
      walletVersion: 2,
    });
  });

  it("D9.3 R-11-11: lançamento de outra wallet lança", () => {
    const { entry } = processedBet();
    const { wallet: other } = openWallet({
      walletId: "wallet-2",
      playerId: "player-1",
      initialBalance: brl("100.00"),
      openingTransactionId: "tx-open-2",
      openingEntryId: "entry-open-2",
      at: T0,
    });

    expect(() => WalletBalanceChanged.from(other, entry, ctx)).toThrow(
      InvalidWalletOperationError,
    );
  });
});

describe("Eventos de transação (D9.3, D9.4, D14.4)", () => {
  const ids = (tx: { id: string }) => ({
    transactionId: tx.id,
    walletId: "wallet-1",
    providerId: "provider-1",
    externalTransactionId: expect.any(String),
    roundId: "round-1",
    gameId: "game-1",
  });

  it("D9.4 D14.4: WagerTransactionProcessed com saldo, versão e sem playerId", () => {
    const { tx, entry } = processedBet();
    const json = roundTrip(WagerTransactionProcessed.from(tx, entry, ctx));

    expect(json.aggregateId).toBe(tx.id);
    expect(json.data).toEqual({
      ...ids(tx),
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
      balanceAfter: { amount: "75.00", currency: "BRL" },
      walletVersion: 2,
    });
    expect("playerId" in json.data).toBe(false);
  });

  it("D9.4: WagerTransactionProcessed de LOSS sai sem walletVersion e com referenceTransactionId", () => {
    const { book, tx: placed } = processedBet();
    const { tx } = book.submit({
      kind: WagerTransactionKind.Loss,
      money: brl("0"),
      referenceExternalTransactionId: "bet-1",
    });
    const json = roundTrip(WagerTransactionProcessed.from(tx, undefined, ctx));

    expect(json.data.referenceTransactionId).toBe(placed.id);
    expect(json.data.balanceAfter).toEqual({
      amount: "75.00",
      currency: "BRL",
    });
    expect("walletVersion" in json.data).toBe(false);
  });

  it("D9.4 D14.5: WagerTransactionProcessed da OPENING tem ids do provedor nulos", () => {
    const { opening } = openWallet({
      walletId: "wallet-9",
      playerId: "player-9",
      initialBalance: brl("1000.00"),
      openingTransactionId: "tx-open",
      openingEntryId: "entry-open",
      at: T0,
    });
    if (!opening) throw new Error("OPENING esperada");
    const json = roundTrip(
      WagerTransactionProcessed.from(opening.transaction, opening.entry, ctx),
    );

    expect(json.data).toEqual({
      transactionId: "tx-open",
      walletId: "wallet-9",
      providerId: null,
      externalTransactionId: null,
      roundId: null,
      gameId: null,
      kind: "OPENING",
      money: { amount: "1000.00", currency: "BRL" },
      balanceAfter: { amount: "1000.00", currency: "BRL" },
      walletVersion: 1,
    });
  });

  it("D9.4: WagerTransactionRejected com failureCode", () => {
    const book = new InMemoryBook();
    book.openWallet("wallet-1", "player-1", brl("10.00"));
    const { tx } = book.submit({ money: brl("20.00") });
    const json = roundTrip(WagerTransactionRejected.from(tx, ctx));

    expect(json.eventType).toBe("WagerTransactionRejected");
    expect(json.aggregateId).toBe(tx.id);
    expect(json.data).toEqual({
      ...ids(tx),
      kind: "BET",
      money: { amount: "20.00", currency: "BRL" },
      failureCode: "INSUFFICIENT_FUNDS",
    });
  });

  it("D9.4 D4.6: WagerTransactionPendingReference com o id externo da referência", () => {
    const book = new InMemoryBook();
    book.openWallet("wallet-1", "player-1", brl("10.00"));
    const { tx } = book.submit({
      kind: WagerTransactionKind.Refund,
      money: brl("5.00"),
      referenceExternalTransactionId: "bet-later",
    });
    const json = roundTrip(WagerTransactionPendingReference.from(tx, ctx));

    expect(json.aggregateId).toBe(tx.id);
    expect(json.data).toEqual({
      ...ids(tx),
      kind: "REFUND",
      referenceExternalTransactionId: "bet-later",
    });
  });

  it("D9.4 D14.1 D14.4: WagerTransactionFailed com PROCESSING_FAILED", () => {
    const book = new InMemoryBook();
    book.openWallet("wallet-1", "player-1", brl("10.00"));
    const { tx } = book.submit({
      kind: WagerTransactionKind.Refund,
      money: brl("5.00"),
      referenceExternalTransactionId: "bet-later",
    });
    tx.fail(FailureCode.ProcessingFailed);
    const json = roundTrip(WagerTransactionFailed.from(tx, ctx));

    expect(json.eventType).toBe("WagerTransactionFailed");
    expect(json.data).toEqual({
      ...ids(tx),
      kind: "REFUND",
      money: { amount: "5.00", currency: "BRL" },
      failureCode: "PROCESSING_FAILED",
    });
  });

  it("D9.4: evento de transação exige o estado correspondente", () => {
    const { tx, entry } = processedBet();
    expect(() => WagerTransactionRejected.from(tx, ctx)).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => WagerTransactionPendingReference.from(tx, ctx)).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => WagerTransactionFailed.from(tx, ctx)).toThrow(
      InvalidTransactionStateError,
    );

    const book = new InMemoryBook();
    book.openWallet("wallet-1", "player-1", brl("1.00"));
    const rejected = book.submit({ money: brl("2.00") }).tx;
    expect(() => WagerTransactionProcessed.from(rejected, entry, ctx)).toThrow(
      InvalidTransactionStateError,
    );
  });
});

describe("WalletOpened (D9.4, D14.4)", () => {
  it("D14.4: data com playerId, moeda, saldo inicial e walletVersion 1", () => {
    const { wallet } = openWallet({
      walletId: "wallet-9",
      playerId: "player-9",
      initialBalance: brl("1000.00"),
      openingTransactionId: "tx-open",
      openingEntryId: "entry-open",
      at: T0,
    });
    const json = roundTrip(WalletOpened.from(wallet, ctx));

    expect(json.eventType).toBe("WalletOpened");
    expect(json.aggregateId).toBe("wallet-9");
    expect(json.data).toEqual({
      walletId: "wallet-9",
      playerId: "player-9",
      currency: "BRL",
      initialBalance: { amount: "1000.00", currency: "BRL" },
      walletVersion: 1,
    });
  });
});

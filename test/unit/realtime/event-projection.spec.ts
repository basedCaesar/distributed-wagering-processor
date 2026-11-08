import { describe, expect, it } from "bun:test";
import { parseRealtimeEvent } from "../../../src/modules/realtime/infra/messaging/realtime-envelope";
import { ValidationError } from "../../../src/shared/errors/app-errors";

const WALLET = "0190f5b8-0000-7000-8000-000000000001";
const TX = "0190f5b8-0000-7000-8000-000000000002";
const REF = "0190f5b8-0000-7000-8000-000000000003";
const EVENT = "0190f5b8-0000-7000-8000-000000000004";
const brl = (amount: string) => ({ amount, currency: "BRL" });

/** Envelope do §11 como o publisher envia (D9.4), com os campos de rastreio. */
function envelope(eventType: string, data: Record<string, unknown>, aggregateId = WALLET): string {
  return JSON.stringify({
    eventId: EVENT,
    eventType,
    aggregateId,
    correlationId: "corr-1",
    causationId: "cause-1",
    occurredAt: "2026-11-08T12:00:00.000Z",
    version: 1,
    data,
  });
}

const txIds = {
  transactionId: TX,
  walletId: WALLET,
  providerId: "provider-a",
  externalTransactionId: "ext-1",
  roundId: "round-987",
  gameId: "fortune-chimp",
};

describe("D28.4: projeção dos eventos por lista fechada", () => {
  it("D28.4 R-11-11: WalletBalanceChanged → só os campos do ledger, com walletVersion, para quem segue a wallet", () => {
    const event = parseRealtimeEvent(
      envelope("WalletBalanceChanged", {
        walletId: WALLET,
        transactionId: TX,
        direction: "DEBIT",
        money: brl("25.00"),
        balanceBefore: brl("100.00"),
        balanceAfter: brl("75.00"),
        walletVersion: 2,
        playerId: "player-que-nao-pode-sair",
      }),
    );

    expect(event).toEqual({
      eventId: EVENT,
      eventType: "WalletBalanceChanged",
      occurredAt: "2026-11-08T12:00:00.000Z",
      walletId: WALLET,
      walletVersion: 2,
      data: {
        transactionId: TX,
        direction: "DEBIT",
        money: brl("25.00"),
        balanceBefore: brl("100.00"),
        balanceAfter: brl("75.00"),
      },
      audience: { kind: "wallet" },
    });
  });

  it("D28.4 D11.1: WalletOpened → moeda e saldo inicial, sem playerId", () => {
    const event = parseRealtimeEvent(
      envelope("WalletOpened", {
        walletId: WALLET,
        playerId: "player-123",
        currency: "BRL",
        initialBalance: brl("100.00"),
        walletVersion: 1,
      }),
    );

    expect(event?.data).toEqual({ currency: "BRL", initialBalance: brl("100.00") });
    expect(event?.walletVersion).toBe(1);
    expect(JSON.stringify(event)).not.toContain("player-123");
  });

  it("D28.4 D10.2: WagerTransactionProcessed → status PROCESSED, sem roundId, gameId nem ids de rastreio; audiência do provedor", () => {
    const event = parseRealtimeEvent(
      envelope(
        "WagerTransactionProcessed",
        {
          ...txIds,
          kind: "WIN",
          money: brl("10.00"),
          referenceTransactionId: REF,
          balanceAfter: brl("110.00"),
          walletVersion: 3,
        },
        TX,
      ),
    );

    expect(event).toEqual({
      eventId: EVENT,
      eventType: "WagerTransactionProcessed",
      occurredAt: "2026-11-08T12:00:00.000Z",
      walletId: WALLET,
      walletVersion: 3,
      data: {
        transactionId: TX,
        providerId: "provider-a",
        externalTransactionId: "ext-1",
        kind: "WIN",
        status: "PROCESSED",
        money: brl("10.00"),
        referenceTransactionId: REF,
        balanceAfter: brl("110.00"),
      },
      audience: { kind: "transaction", providerId: "provider-a" },
    });
    const text = JSON.stringify(event);
    for (const hidden of ["round-987", "fortune-chimp", "corr-1", "cause-1"]) expect(text).not.toContain(hidden);
  });

  it("D28.4: WagerTransactionProcessed sem walletVersion (LOSS) → walletVersion null", () => {
    const event = parseRealtimeEvent(
      envelope("WagerTransactionProcessed", { ...txIds, kind: "LOSS", money: brl("0.00"), balanceAfter: brl("100.00") }, TX),
    );

    expect(event?.walletVersion).toBeNull();
    expect(event?.data).not.toHaveProperty("referenceTransactionId");
  });

  it("D28.4: Rejected, PendingReference e Failed → status e o campo do desfecho", () => {
    const rejected = parseRealtimeEvent(
      envelope("WagerTransactionRejected", { ...txIds, kind: "BET", money: brl("999.00"), failureCode: "INSUFFICIENT_FUNDS" }, TX),
    );
    const pending = parseRealtimeEvent(
      envelope("WagerTransactionPendingReference", { ...txIds, kind: "WIN", referenceExternalTransactionId: "ext-0" }, TX),
    );
    const failed = parseRealtimeEvent(
      envelope("WagerTransactionFailed", { ...txIds, kind: "WIN", money: brl("5.00"), failureCode: "PROCESSING_FAILED" }, TX),
    );

    expect(rejected?.data).toEqual({
      transactionId: TX,
      providerId: "provider-a",
      externalTransactionId: "ext-1",
      kind: "BET",
      status: "REJECTED",
      money: brl("999.00"),
      failureCode: "INSUFFICIENT_FUNDS",
    });
    expect(pending?.data).toEqual({
      transactionId: TX,
      providerId: "provider-a",
      externalTransactionId: "ext-1",
      kind: "WIN",
      status: "PENDING_REFERENCE",
      referenceExternalTransactionId: "ext-0",
    });
    expect(failed?.data).toMatchObject({ status: "FAILED", failureCode: "PROCESSING_FAILED", money: brl("5.00") });
    for (const event of [rejected, pending, failed]) expect(event?.walletVersion).toBeNull();
  });

  it("D28.3: a OPENING (providerId nulo) tem audiência de transação sem provedor", () => {
    const event = parseRealtimeEvent(
      envelope(
        "WagerTransactionProcessed",
        {
          ...txIds,
          providerId: null,
          externalTransactionId: null,
          roundId: null,
          gameId: null,
          kind: "OPENING",
          money: brl("100.00"),
          balanceAfter: brl("100.00"),
          walletVersion: 1,
        },
        TX,
      ),
    );

    expect(event?.audience).toEqual({ kind: "transaction", providerId: null });
  });

  it("D28.4: eventType fora da lista é ignorado (null), não inválido", () => {
    expect(parseRealtimeEvent(envelope("SomethingNew", { walletId: WALLET }))).toBeNull();
  });

  it.each([
    ["JSON quebrado", "{nao-json"],
    ["sem eventId", JSON.stringify({ eventType: "WalletOpened", data: {} })],
    [
      "WalletBalanceChanged sem balanceAfter",
      envelope("WalletBalanceChanged", {
        walletId: WALLET,
        transactionId: TX,
        direction: "DEBIT",
        money: brl("1.00"),
        balanceBefore: brl("2.00"),
        walletVersion: 2,
      }),
    ],
    [
      "valor como number (D2)",
      envelope("WalletBalanceChanged", {
        walletId: WALLET,
        transactionId: TX,
        direction: "DEBIT",
        money: { amount: 1, currency: "BRL" },
        balanceBefore: brl("2.00"),
        balanceAfter: brl("1.00"),
        walletVersion: 2,
      }),
    ],
    ["walletId que não é UUID", envelope("WalletOpened", { walletId: "x", currency: "BRL", initialBalance: brl("1.00"), walletVersion: 1 })],
  ])("D28.7: envelope inválido (%s) → ValidationError", (_, body) => {
    expect(() => parseRealtimeEvent(body)).toThrow(ValidationError);
  });
});

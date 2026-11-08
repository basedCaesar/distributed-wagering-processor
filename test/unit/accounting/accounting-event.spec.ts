import { describe, expect, it } from "bun:test";
import { parseAccountingEvent } from "../../../src/modules/accounting/infra/messaging/accounting-event.schema";
import { ValidationError } from "../../../src/shared/errors/app-errors";
import { balanceChanged, transactionProcessed } from "../../support/accounting";

const walletId = "0196f0aa-0000-7000-8000-000000000001";
const transactionId = "0196f0aa-0000-7000-8000-000000000002";

const mutate = (body: string, change: (json: Record<string, unknown>) => void): string => {
  const json = JSON.parse(body) as Record<string, unknown>;
  change(json);
  return JSON.stringify(json);
};

describe("D27.1 D27.5: leitura dos eventos do accounting", () => {
  it("D27.1: WalletBalanceChanged → metade com direção, valor, saldos e versão", () => {
    const event = balanceChanged({
      walletId,
      transactionId,
      direction: "DEBIT",
      amount: "25.00",
      before: "100.00",
      after: "75.00",
      walletVersion: 2,
    });

    const parsed = parseAccountingEvent(event.body);

    expect(parsed.eventId).toBe(event.eventId);
    expect(parsed.walletId).toBe(walletId);
    expect(parsed.half).toMatchObject({
      type: "WalletBalanceChanged",
      eventId: event.eventId,
      transactionId,
      walletId,
      walletVersion: 2,
      direction: "DEBIT",
    });
    if (parsed.half?.type !== "WalletBalanceChanged") throw new Error("metade errada");
    expect(parsed.half.amount.toString()).toBe("25.00");
    expect(parsed.half.balanceBefore.toString()).toBe("100.00");
    expect(parsed.half.balanceAfter.toString()).toBe("75.00");
    expect(parsed.envelope).toEqual(JSON.parse(event.body));
  });

  it("D27.1: WagerTransactionProcessed com walletVersion → metade com o kind", () => {
    const event = transactionProcessed({ walletId, transactionId, kind: "BET", amount: "25.00", after: "75.00", walletVersion: 2 });

    const parsed = parseAccountingEvent(event.body);

    expect(parsed.half).toMatchObject({ type: "WagerTransactionProcessed", kind: "BET", walletVersion: 2, transactionId });
  });

  it("D27.1: WagerTransactionProcessed sem walletVersion (LOSS) → sem metade (ack sem efeito)", () => {
    const event = transactionProcessed({ walletId, transactionId, kind: "LOSS", amount: "0.00", after: "75.00" });

    expect(parseAccountingEvent(event.body).half).toBeUndefined();
  });

  it("D27.1: outro eventType com envelope válido → sem metade", () => {
    const body = mutate(balanceChanged({ walletId, transactionId, direction: "DEBIT", amount: "1.00", before: "2.00", after: "1.00", walletVersion: 2 }).body, (json) => {
      json.eventType = "WalletOpened";
      json.data = { walletId, currency: "BRL", initialBalance: { amount: "2.00", currency: "BRL" }, walletVersion: 1 };
    });

    expect(parseAccountingEvent(body).half).toBeUndefined();
  });

  it("D27.5: JSON quebrado → ValidationError", () => {
    expect(() => parseAccountingEvent("{nope")).toThrow(ValidationError);
  });

  it.each([
    ["sem eventId", (json: Record<string, unknown>) => delete json.eventId],
    ["eventId que não é UUID", (json: Record<string, unknown>) => (json.eventId = "msg-1")],
    ["direction desconhecida", (json: Record<string, unknown>) => ((json.data as Record<string, unknown>).direction = "SIDEWAYS")],
    ["money como number", (json: Record<string, unknown>) => ((json.data as Record<string, unknown>).money = { amount: 25, currency: "BRL" })],
    ["money com 3 casas", (json: Record<string, unknown>) => ((json.data as Record<string, unknown>).money = { amount: "25.000", currency: "BRL" })],
    ["walletVersion 0", (json: Record<string, unknown>) => ((json.data as Record<string, unknown>).walletVersion = 0)],
    ["sem transactionId", (json: Record<string, unknown>) => delete (json.data as Record<string, unknown>).transactionId],
    ["moedas diferentes no mesmo evento", (json: Record<string, unknown>) => ((json.data as Record<string, unknown>).balanceAfter = { amount: "75.00", currency: "USD" })],
  ])("D27.5: WalletBalanceChanged %s → ValidationError", (_name, change) => {
    const body = mutate(
      balanceChanged({ walletId, transactionId, direction: "DEBIT", amount: "25.00", before: "100.00", after: "75.00", walletVersion: 2 }).body,
      change,
    );

    expect(() => parseAccountingEvent(body)).toThrow(ValidationError);
  });

  it("D27.5: WagerTransactionProcessed com kind fora da lista → ValidationError", () => {
    const body = mutate(
      transactionProcessed({ walletId, transactionId, kind: "BET", amount: "25.00", after: "75.00", walletVersion: 2 }).body,
      (json) => ((json.data as Record<string, unknown>).kind = "DEPOSIT"),
    );

    expect(() => parseAccountingEvent(body)).toThrow(ValidationError);
  });

  it("D11.1 D27.5: o erro de validação não carrega valores do evento", () => {
    const body = mutate(
      balanceChanged({ walletId, transactionId, direction: "DEBIT", amount: "25.00", before: "100.00", after: "75.00", walletVersion: 2 }).body,
      (json) => ((json.data as Record<string, unknown>).money = { amount: "123456.789", currency: "BRL" }),
    );

    let caught: unknown;
    try {
      parseAccountingEvent(body);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(JSON.stringify({ message: (caught as Error).message, details: (caught as ValidationError).details })).not.toContain("123456.789");
  });
});

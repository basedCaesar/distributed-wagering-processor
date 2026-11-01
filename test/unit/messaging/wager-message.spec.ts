import { describe, expect, it } from "bun:test";
import { WagerTransactionKind } from "../../../src/modules/wagering/domain/wager-transaction";
import { parseWagerMessage } from "../../../src/modules/wagering/infra/messaging/wager-message.schema";
import { ValidationError } from "../../../src/shared/errors/app-errors";

const CURRENCIES = ["BRL", "USD"];

/** A mensagem do §10 (L549–567), literal. */
const SECTION_10 = {
  messageId: "msg-123",
  type: "WagerTransactionRequested",
  occurredAt: "2026-07-29T15:00:00.000Z",
  data: {
    providerId: "provider-a",
    externalTransactionId: "transaction-123",
    idempotencyKey: "provider-a:transaction-123",
    playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
  },
};

function withData(data: Record<string, unknown>): string {
  return JSON.stringify({ ...SECTION_10, data: { ...SECTION_10.data, ...data } });
}

function expectInvalid(body: string): void {
  expect(() => parseWagerMessage(body, CURRENCIES)).toThrow(ValidationError);
}

describe("R-10-02 D19.5: envelope da mensagem da fila", () => {
  it("R-10-02: a mensagem do §10, literal, vira o comando do use case", () => {
    const parsed = parseWagerMessage(JSON.stringify(SECTION_10), CURRENCIES);

    expect(parsed.messageId).toBe("msg-123");
    expect(parsed.type).toBe("WagerTransactionRequested");
    expect(parsed.command).toMatchObject({
      idempotencyKey: "provider-a:transaction-123",
      providerId: "provider-a",
      externalTransactionId: "transaction-123",
      playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
      walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
      roundId: "round-987",
      gameId: "fortune-chimp",
      kind: WagerTransactionKind.Bet,
      referenceExternalTransactionId: undefined,
    });
    expect(parsed.command.money.toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
  });

  it("D2.1 D19.5: amount \"25\" é normalizado para 25.00, como no HTTP", () => {
    const parsed = parseWagerMessage(withData({ money: { amount: "25", currency: "BRL" } }), CURRENCIES);
    expect(parsed.command.money.toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
  });

  it("D19.5: messageId é qualquer texto não vazio de até 255 caracteres", () => {
    const free = "msg 123/ç#!";
    expect(parseWagerMessage(JSON.stringify({ ...SECTION_10, messageId: free }), CURRENCIES).messageId).toBe(free);
    const longest = "m".repeat(255);
    expect(parseWagerMessage(JSON.stringify({ ...SECTION_10, messageId: longest }), CURRENCIES).messageId).toBe(longest);
    expectInvalid(JSON.stringify({ ...SECTION_10, messageId: "" }));
    expectInvalid(JSON.stringify({ ...SECTION_10, messageId: "m".repeat(256) }));
    expectInvalid(JSON.stringify({ ...SECTION_10, messageId: 123 }));
  });

  it("D19.5: campos extras no envelope e no data são descartados, como no HTTP", () => {
    const parsed = parseWagerMessage(
      JSON.stringify({ ...SECTION_10, extra: 1, data: { ...SECTION_10.data, extra: "x" } }),
      CURRENCIES,
    );
    expect(parsed.command).not.toHaveProperty("extra");
  });

  it("D8.2 D19.5: JSON quebrado → inválido", () => {
    expectInvalid("{ not json");
    expectInvalid("");
    expectInvalid("null");
    expectInvalid("[]");
  });

  it("D8.2 D19.5: type desconhecido ou ausente → inválido", () => {
    expectInvalid(JSON.stringify({ ...SECTION_10, type: "WalletOpened" }));
    const { type: _type, ...withoutType } = SECTION_10;
    expectInvalid(JSON.stringify(withoutType));
  });

  it("D19.5: occurredAt fora de ISO 8601 → inválido", () => {
    expectInvalid(JSON.stringify({ ...SECTION_10, occurredAt: "ontem" }));
  });

  it("D3.8 D19.5: idempotencyKey ausente, vazia ou com mais de 255 → inválido", () => {
    const { idempotencyKey: _key, ...withoutKey } = SECTION_10.data;
    expectInvalid(JSON.stringify({ ...SECTION_10, data: withoutKey }));
    expectInvalid(withData({ idempotencyKey: "" }));
    expectInvalid(withData({ idempotencyKey: "k".repeat(256) }));
  });

  it("D8.2 R-06-38: kind OPENING → inválido", () => {
    expectInvalid(withData({ kind: "OPENING" }));
  });

  it("D5 D19.5: o mesmo zod do HTTP: moeda fora da lista, 3 casas, providerId fora do formato → inválido", () => {
    expectInvalid(withData({ money: { amount: "25.00", currency: "EUR" } }));
    expectInvalid(withData({ money: { amount: "25.001", currency: "BRL" } }));
    expectInvalid(withData({ providerId: "provider a" }));
    expectInvalid(withData({ walletId: "not-a-uuid" }));
  });
});

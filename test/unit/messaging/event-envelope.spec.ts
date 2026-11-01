import { describe, expect, it } from "bun:test";
import { parseEventEnvelope } from "../../../src/modules/wagering/infra/messaging/event-envelope.schema";
import { ValidationError } from "../../../src/shared/errors/app-errors";

const WALLET = "0192f291-27dd-7d3f-8071-5f8685deef37";

const envelope = (overrides: Record<string, unknown> = {}) => ({
  eventId: "0192f2a0-0000-7000-8000-000000000001",
  eventType: "WalletBalanceChanged",
  aggregateId: WALLET,
  correlationId: "msg-123",
  causationId: "msg-123",
  occurredAt: "2026-07-29T15:00:00.000Z",
  version: 1,
  data: { walletId: WALLET, walletVersion: 2, transactionId: "0192f2a0-0000-7000-8000-000000000002" },
  ...overrides,
});

describe("D20.2 R-11-09: envelope do §11 no auditor", () => {
  it("R-11-09: envelope válido → evento auditável, com o envelope cru para o hash", () => {
    const raw = envelope();

    const parsed = parseEventEnvelope(JSON.stringify(raw));

    expect(parsed).toEqual({
      eventId: raw.eventId,
      eventType: "WalletBalanceChanged",
      aggregateId: WALLET,
      correlationId: "msg-123",
      occurredAt: new Date("2026-07-29T15:00:00.000Z"),
      walletId: WALLET,
      walletVersion: 2,
      envelope: raw,
    });
  });

  it("D20.2: qualquer eventType com envelope válido é aceito (eventos novos não quebram o auditor)", () => {
    const parsed = parseEventEnvelope(JSON.stringify(envelope({ eventType: "WalletFrozen", data: {} })));

    expect(parsed.eventType).toBe("WalletFrozen");
    expect(parsed.walletId).toBeUndefined();
    expect(parsed.walletVersion).toBeUndefined();
  });

  it("D20.2: sem walletVersion no data (ex.: rejeição) → só a wallet", () => {
    const parsed = parseEventEnvelope(
      JSON.stringify(envelope({ eventType: "WagerTransactionRejected", data: { walletId: WALLET } })),
    );

    expect(parsed.walletId).toBe(WALLET);
    expect(parsed.walletVersion).toBeUndefined();
  });

  it.each([
    ["JSON quebrado", "{ quebrado"],
    ["sem eventId", JSON.stringify({ ...envelope(), eventId: undefined })],
    ["eventId que não é UUID", JSON.stringify(envelope({ eventId: "evt-1" }))],
    ["aggregateId que não é UUID", JSON.stringify(envelope({ aggregateId: "wallet-1" }))],
    ["occurredAt fora do ISO 8601", JSON.stringify(envelope({ occurredAt: "ontem" }))],
    ["version zero", JSON.stringify(envelope({ version: 0 }))],
    ["walletVersion sem walletId", JSON.stringify(envelope({ data: { walletVersion: 2 } }))],
    ["walletVersion zero", JSON.stringify(envelope({ data: { walletId: WALLET, walletVersion: 0 } }))],
    ["walletVersion fracionária", JSON.stringify(envelope({ data: { walletId: WALLET, walletVersion: 2.5 } }))],
    ["data ausente", JSON.stringify({ ...envelope(), data: undefined })],
  ])("D20.2: %s → ValidationError (permanente, DLQ)", (_, body) => {
    expect(() => parseEventEnvelope(body)).toThrow(ValidationError);
  });
});

import { z } from "zod";
import { ValidationError } from "../../../../shared/errors/app-errors";
import { parseOrThrow } from "../../../../shared/http/zod";
import type { EventHalf } from "../../application/ports";
import { Amount } from "../../domain/amount";

/** `MoneyProps` (§11): string decimal com 2 casas, nunca number (D2). */
const money = z.object({
  amount: z.string().regex(/^(0|[1-9][0-9]{0,11})\.[0-9]{2}$/, "amount: decimal com 2 casas"),
  currency: z.string().regex(/^[A-Z]{3}$/, "currency: 3 letras"),
});

const walletVersion = z.number().int("walletVersion: inteiro").min(1, "walletVersion ≥ 1");

/** Envelope do §11 (R-11-09), o mesmo formato que o auditor aceita (D20.2). */
const envelopeSchema = z.object({
  eventId: z.uuid("eventId: UUID"),
  eventType: z.string().regex(/^[A-Z][A-Za-z0-9]{0,127}$/, "eventType: nome do evento"),
  aggregateId: z.uuid("aggregateId: UUID"),
  correlationId: z.string().min(1).max(255),
  causationId: z.string().min(1).max(255).optional(),
  occurredAt: z.iso.datetime("occurredAt: ISO 8601"),
  version: z.number().int().min(1, "version ≥ 1"),
  data: z.looseObject({ walletId: z.uuid("data.walletId: UUID").optional() }),
});

/** `WalletBalanceChangedData` do §11. */
const balanceChangedData = z
  .looseObject({
    walletId: z.uuid(),
    transactionId: z.uuid(),
    direction: z.enum(["DEBIT", "CREDIT"]),
    money,
    balanceBefore: money,
    balanceAfter: money,
    walletVersion,
  })
  .refine(
    (data) => data.money.currency === data.balanceBefore.currency && data.money.currency === data.balanceAfter.currency,
    { message: "moedas diferentes no mesmo evento" },
  );

/** `WagerTransactionProcessedData` (D9.4). */
const transactionProcessedData = z
  .looseObject({
    walletId: z.uuid(),
    transactionId: z.uuid(),
    kind: z.enum(["OPENING", "BET", "WIN", "LOSS", "REFUND", "ROLLBACK"]),
    money,
    balanceAfter: money,
    walletVersion: walletVersion.optional(),
  })
  .refine((data) => data.money.currency === data.balanceAfter.currency, { message: "moedas diferentes no mesmo evento" });

export interface ParsedAccountingEvent {
  eventId: string;
  eventType: string;
  correlationId: string;
  walletId?: string;
  /** A metade a gravar; ausente quando o evento não tem efeito no diário (D27.1). */
  half?: EventHalf;
  /** O envelope cru: entra no hash da inbox (D27.5). */
  envelope: unknown;
}

/**
 * Corpo da mensagem (envelope do SNS com `RawMessageDelivery`) → o que o
 * accounting faz com ele (D27.1). JSON quebrado ou fora do schema →
 * `ValidationError` (permanente, DLQ, D27.5), sem valores no erro (D11.1).
 * `WagerTransactionProcessed` sem `walletVersion` e os outros tipos não
 * têm metade: ack sem tocar no banco.
 */
export function parseAccountingEvent(body: string): ParsedAccountingEvent {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ValidationError("evento não é JSON");
  }
  const envelope = parseOrThrow(envelopeSchema, json, "evento");
  const base = {
    eventId: envelope.eventId,
    eventType: envelope.eventType,
    correlationId: envelope.correlationId,
    ...(envelope.data.walletId !== undefined && { walletId: envelope.data.walletId }),
    envelope: json,
  };
  const occurredAt = new Date(envelope.occurredAt);

  if (envelope.eventType === "WalletBalanceChanged") {
    const data = parseOrThrow(balanceChangedData, envelope.data, "WalletBalanceChanged");
    return {
      ...base,
      half: {
        type: "WalletBalanceChanged",
        eventId: envelope.eventId,
        transactionId: data.transactionId,
        walletId: data.walletId,
        walletVersion: data.walletVersion,
        direction: data.direction,
        amount: Amount.parse(data.money),
        balanceBefore: Amount.parse(data.balanceBefore),
        balanceAfter: Amount.parse(data.balanceAfter),
        occurredAt,
      },
    };
  }
  if (envelope.eventType === "WagerTransactionProcessed") {
    const data = parseOrThrow(transactionProcessedData, envelope.data, "WagerTransactionProcessed");
    if (data.walletVersion === undefined) return base;
    return {
      ...base,
      half: {
        type: "WagerTransactionProcessed",
        eventId: envelope.eventId,
        transactionId: data.transactionId,
        walletId: data.walletId,
        walletVersion: data.walletVersion,
        kind: data.kind,
        amount: Amount.parse(data.money),
        balanceAfter: Amount.parse(data.balanceAfter),
        occurredAt,
      },
    };
  }
  return base;
}

import { z } from "zod";
import { ValidationError } from "../../../../shared/errors/app-errors";
import { parseOrThrow } from "../../../../shared/http/zod";
import type { Audience, RealtimeEvent } from "../../domain/realtime-event";

/**
 * Schema **próprio** do envelope do §11 (D28.1): o contrato entre os
 * serviços é o enunciado, não o código do núcleo. Os `z.object` descartam
 * os campos que não estão aqui: a lista fechada da D28.4.
 */
const money = z.object({
  amount: z.string().regex(/^\d{1,12}\.\d{2}$/, "amount: 2 casas"),
  currency: z.string().regex(/^[A-Z]{3}$/, "currency: ISO 4217"),
});
const uuid = z.uuid();
const version = z.number().int().min(1);
const kind = z.enum(["OPENING", "BET", "WIN", "LOSS", "REFUND", "ROLLBACK"]);
const failureCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);

const envelope = z.object({
  eventId: uuid,
  eventType: z.string().regex(/^[A-Z][A-Za-z0-9]{0,127}$/),
  occurredAt: z.iso.datetime(),
  data: z.record(z.string(), z.unknown()),
});

const transactionIds = {
  transactionId: uuid,
  walletId: uuid,
  providerId: z.string().min(1).max(255).nullable(),
  externalTransactionId: z.string().min(1).max(255).nullable(),
  kind,
};

interface Projection {
  walletId: string;
  walletVersion: number | null;
  data: Record<string, unknown>;
  audience: Audience;
}

/** Os 6 eventos que o cliente recebe (D9.4, D28.4), cada um com o `data` que pode ver. */
const PROJECTIONS: Record<string, (data: unknown) => Projection> = {
  WalletBalanceChanged: (raw) => {
    const { walletId, walletVersion, ...data } = parseOrThrow(
      z.object({
        walletId: uuid,
        transactionId: uuid,
        direction: z.enum(["DEBIT", "CREDIT"]),
        money,
        balanceBefore: money,
        balanceAfter: money,
        walletVersion: version,
      }),
      raw,
      "WalletBalanceChanged",
    );
    return { walletId, walletVersion, data, audience: { kind: "wallet" } };
  },
  WalletOpened: (raw) => {
    const { walletId, walletVersion, ...data } = parseOrThrow(
      z.object({ walletId: uuid, currency: z.string().regex(/^[A-Z]{3}$/), initialBalance: money, walletVersion: version }),
      raw,
      "WalletOpened",
    );
    return { walletId, walletVersion, data, audience: { kind: "wallet" } };
  },
  WagerTransactionProcessed: (raw) => {
    const { walletId, walletVersion, ...rest } = parseOrThrow(
      z.object({
        ...transactionIds,
        money,
        referenceTransactionId: uuid.optional(),
        balanceAfter: money,
        walletVersion: version.optional(),
      }),
      raw,
      "WagerTransactionProcessed",
    );
    return transaction(walletId, walletVersion ?? null, { ...rest, status: "PROCESSED" });
  },
  WagerTransactionRejected: (raw) => {
    const { walletId, ...rest } = parseOrThrow(
      z.object({ ...transactionIds, money, failureCode }),
      raw,
      "WagerTransactionRejected",
    );
    return transaction(walletId, null, { ...rest, status: "REJECTED" });
  },
  WagerTransactionPendingReference: (raw) => {
    const { walletId, ...rest } = parseOrThrow(
      z.object({ ...transactionIds, referenceExternalTransactionId: z.string().min(1).max(255) }),
      raw,
      "WagerTransactionPendingReference",
    );
    return transaction(walletId, null, { ...rest, status: "PENDING_REFERENCE" });
  },
  WagerTransactionFailed: (raw) => {
    const { walletId, ...rest } = parseOrThrow(
      z.object({ ...transactionIds, money, failureCode }),
      raw,
      "WagerTransactionFailed",
    );
    return transaction(walletId, null, { ...rest, status: "FAILED" });
  },
};

/** Ordem fixa dos campos de transação no `data` (o mesmo JSON para o mesmo evento). */
const TRANSACTION_FIELDS = [
  "transactionId",
  "providerId",
  "externalTransactionId",
  "kind",
  "status",
  "money",
  "referenceTransactionId",
  "referenceExternalTransactionId",
  "failureCode",
  "balanceAfter",
] as const;

function transaction(walletId: string, walletVersion: number | null, fields: Record<string, unknown>): Projection {
  const data: Record<string, unknown> = {};
  for (const field of TRANSACTION_FIELDS) if (fields[field] !== undefined) data[field] = fields[field];
  return {
    walletId,
    walletVersion,
    data,
    audience: { kind: "transaction", providerId: fields.providerId as string | null },
  };
}

/**
 * Corpo da mensagem (o envelope cru, `RawMessageDelivery`) → evento
 * projetado. `null` para um `eventType` fora da lista (ignorado, D28.4).
 * JSON quebrado ou fora do schema → `ValidationError` (inválido, D28.7),
 * sem nenhum valor recebido na mensagem do erro.
 */
export function parseRealtimeEvent(body: string): RealtimeEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ValidationError("evento não é JSON");
  }
  const parsed = parseOrThrow(envelope, json, "evento");
  const project = PROJECTIONS[parsed.eventType];
  if (project === undefined) return null;
  const projection = project(parsed.data);
  return {
    eventId: parsed.eventId,
    eventType: parsed.eventType,
    occurredAt: parsed.occurredAt,
    ...projection,
  };
}

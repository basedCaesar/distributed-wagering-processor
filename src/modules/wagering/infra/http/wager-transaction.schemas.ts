import { z } from "zod";
import { WagerTransactionKind } from "../../domain/wager-transaction";
import { moneyInputSchema, playerIdSchema, walletIdSchema } from "./wallet.schemas";

/** D17.1: o formato da D6.4 para os ids que vêm do provedor. */
export const providerIdentifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,128}$/, "1 a 128 caracteres [A-Za-z0-9._:-] (D17.1)");

/** D5: obrigatória e com até 255 caracteres; vazia conta como ausente. */
export const idempotencyKeySchema = z
  .string("Idempotency-Key obrigatória")
  .min(1, "Idempotency-Key obrigatória")
  .max(255, "Idempotency-Key: até 255 caracteres");

/** D17.3. */
export const transactionIdSchema = z.uuid("transactionId precisa ser UUID");

/** `OPENING` é interno e não é submetido (R-06-38). */
const SUBMITTABLE_KINDS = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;

/**
 * Corpo do `POST /wagering/transactions` (R-09-10, D5, D17.1). A exigência
 * de referência por kind e o sinal do valor ficam no `WagerTransaction.create`
 * (D1.5, D2.3), que também responde `400`.
 */
export function submitTransactionSchema(currencies: readonly string[]) {
  return z.object({
    providerId: providerIdentifierSchema,
    externalTransactionId: providerIdentifierSchema,
    playerId: playerIdSchema,
    walletId: walletIdSchema,
    roundId: providerIdentifierSchema,
    gameId: providerIdentifierSchema,
    kind: z.enum(SUBMITTABLE_KINDS, "kind: BET, WIN, LOSS, REFUND ou ROLLBACK"),
    money: moneyInputSchema(currencies),
    referenceExternalTransactionId: providerIdentifierSchema.optional(),
  });
}

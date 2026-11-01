import { z } from "zod";
import { ValidationError } from "../../../../shared/errors/app-errors";
import { parseOrThrow } from "../../../../shared/http/zod";
import type { SubmitWagerTransactionCommand } from "../../application/submit-wager-transaction.use-case";
import {
  idempotencyKeySchema,
  submitTransactionSchema,
} from "../http/wager-transaction.schemas";

export const WAGER_MESSAGE_TYPE = "WagerTransactionRequested";

/**
 * Envelope do §10 (R-10-02, D19.5). O `data` usa **o mesmo zod** do corpo
 * HTTP, mais o `idempotencyKey` com o zod do header: a fila aceita e recusa
 * o mesmo que o HTTP, e campos extras são descartados nos dois.
 */
function wagerMessageSchema(currencies: readonly string[]) {
  return z.object({
    messageId: z.string().min(1, "messageId obrigatório").max(255, "messageId: até 255 caracteres"),
    type: z.literal(WAGER_MESSAGE_TYPE, `type: só ${WAGER_MESSAGE_TYPE}`),
    occurredAt: z.iso.datetime("occurredAt: ISO 8601"),
    data: submitTransactionSchema(currencies).extend({ idempotencyKey: idempotencyKeySchema }),
  });
}

export interface ParsedWagerMessage {
  messageId: string;
  type: string;
  command: SubmitWagerTransactionCommand;
}

/**
 * Corpo da mensagem → comando do use case. JSON quebrado ou fora do
 * schema → `ValidationError` (permanente, DLQ, D8.2). O valor recebido
 * nunca vai para o erro (D11.1).
 */
export function parseWagerMessage(body: string, currencies: readonly string[]): ParsedWagerMessage {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ValidationError("mensagem não é JSON");
  }
  const message = parseOrThrow(wagerMessageSchema(currencies), json, "mensagem");
  const { data } = message;
  return {
    messageId: message.messageId,
    type: message.type,
    command: {
      idempotencyKey: data.idempotencyKey,
      providerId: data.providerId,
      externalTransactionId: data.externalTransactionId,
      playerId: data.playerId,
      walletId: data.walletId,
      roundId: data.roundId,
      gameId: data.gameId,
      kind: data.kind,
      money: data.money,
      referenceExternalTransactionId: data.referenceExternalTransactionId,
    },
  };
}

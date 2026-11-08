import { z } from "zod";
import { ValidationError } from "../../../../shared/errors/app-errors";
import { parseOrThrow } from "../../../../shared/http/zod";

/** Frames do cliente (D28.2). */
const clientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auth"), token: z.string().min(1, "token vazio").max(4096) }),
  z.object({ type: z.literal("follow"), walletId: z.uuid("walletId: UUID") }),
  z.object({ type: z.literal("unfollow"), walletId: z.uuid("walletId: UUID") }),
]);

export type ClientMessage = z.infer<typeof clientMessage>;

function json(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ValidationError("frame não é JSON");
  }
}

/**
 * Frame de texto → mensagem do protocolo, ou `ValidationError`. A mensagem
 * do erro leva só o caminho e o problema, nunca o valor (o token, D11.1).
 */
export function parseClientMessage(raw: string): ClientMessage {
  return parseOrThrow(clientMessage, json(raw), "frame");
}

/**
 * O frame é uma tentativa de `auth` (o `type` é `auth`), mesmo sem token
 * válido: antes da autenticação, isso é `4401` (token ausente), não `4400`
 * (protocolo violado), D28.2.
 */
export function isAuthAttempt(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && (parsed as { type?: unknown }).type === "auth";
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

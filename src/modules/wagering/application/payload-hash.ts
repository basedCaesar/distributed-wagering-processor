import { createHash } from "node:crypto";
import type { Money } from "../domain/money";
import type { WagerTransactionKind } from "../domain/wager-transaction";

/** Campos de negócio que entram no hash (D3.3). Key e metadados de transporte ficam fora. */
export interface PayloadHashFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  /** Já normalizado para 2 casas pelo `Money.from` (D2.1). */
  money: Money;
  referenceExternalTransactionId: string | undefined;
}

/** JSON com as chaves ordenadas em todos os níveis e sem espaços (D3.3, R-09-14). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * `payloadHash` = SHA-256 (hex) do JSON canônico dos campos de negócio
 * (D3.3). O mesmo no HTTP e na fila, então um reenvio pelo outro canal é
 * replay. Só os campos listados entram, mesmo que o chamador passe mais.
 */
export function payloadHash(fields: PayloadHashFields): string {
  const subset = {
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    playerId: fields.playerId,
    walletId: fields.walletId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: fields.kind,
    money: fields.money.toJSON(),
    referenceExternalTransactionId: fields.referenceExternalTransactionId,
  };
  return createHash("sha256").update(canonicalJson(subset)).digest("hex");
}

/**
 * Hash da inbox do auditor (D20.1) = SHA-256 (hex) do JSON canônico do
 * envelope inteiro. Chaves ordenadas: a ordem do `jsonb` (D20.9) não muda
 * o hash; qualquer mudança de conteúdo muda.
 */
export function envelopeHash(envelope: unknown): string {
  return createHash("sha256").update(canonicalJson(envelope)).digest("hex");
}

/**
 * Hash da inbox (D3.8) = SHA-256 (hex) do JSON canônico de `payloadHash` e
 * `type`. Fora `occurredAt`, a key e o `messageId`: um reenvio do produtor
 * com outro `occurredAt` é a mesma mensagem.
 */
export function inboxHash(payloadHashHex: string, type: string): string {
  return createHash("sha256")
    .update(canonicalJson({ payloadHash: payloadHashHex, type }))
    .digest("hex");
}

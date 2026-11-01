import { InvalidCursorError } from "./errors";

const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** `wallet_version` é `integer` no banco: 1 até 2^31 − 1. */
const VERSION = /^[1-9]\d{0,9}$/;
const MAX_VERSION = 2_147_483_647;

/**
 * Cursor opaco do ledger (D6.8): base64url da última `walletVersion` da
 * página. Lançamentos são imutáveis e a versão só cresce, então o cursor é
 * estável com inserções (L466).
 */
export function encodeLedgerCursor(walletVersion: number): string {
  return Buffer.from(String(walletVersion)).toString("base64url");
}

export function decodeLedgerCursor(cursor: string): number {
  if (!BASE64URL.test(cursor)) throw new InvalidCursorError();
  const decoded = Buffer.from(cursor, "base64url").toString();
  if (!VERSION.test(decoded)) throw new InvalidCursorError();
  const version = Number(decoded);
  if (version > MAX_VERSION) throw new InvalidCursorError();
  return version;
}

import { createHash } from "node:crypto";

/**
 * JSON com as chaves ordenadas em todos os níveis e sem espaços. A mesma
 * regra do hash da inbox do núcleo (D3.3, D20.1), escrita aqui porque o
 * accounting não importa a aplicação do núcleo (D27.8).
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 (hex) do JSON canônico do envelope: o hash da inbox do accounting (D27.5). */
export function envelopeHash(envelope: unknown): string {
  return createHash("sha256").update(canonicalJson(envelope)).digest("hex");
}

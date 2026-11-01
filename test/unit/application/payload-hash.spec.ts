import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import fc from "fast-check";
import {
  canonicalJson,
  type PayloadHashFields,
  payloadHash,
} from "../../../src/modules/wagering/application/payload-hash";
import { Money } from "../../../src/modules/wagering/domain/money";
import { WagerTransactionKind } from "../../../src/modules/wagering/domain/wager-transaction";

/** O corpo do §9 (L478–488), como o use case recebe. */
const SECTION_9: PayloadHashFields = {
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: WagerTransactionKind.Bet,
  money: Money.from({ amount: "25.00", currency: "BRL" }),
  referenceExternalTransactionId: undefined,
};

const SECTION_9_CANONICAL =
  '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET",' +
  '"money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",' +
  '"providerId":"provider-a","roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}';

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe("S4 D3.3 R-09-14: payloadHash", () => {
  it("D3.3 R-09-14: SHA-256 (hex) do JSON canônico, chaves ordenadas e sem espaços; vetor fixo do §9", () => {
    expect(payloadHash(SECTION_9)).toBe(sha256(SECTION_9_CANONICAL));
    expect(payloadHash(SECTION_9)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("D3.3: canonicalJson ordena as chaves em todos os níveis", () => {
    expect(canonicalJson({ b: 1, a: { d: "x", c: [{ f: 2, e: 1 }] } })).toBe(
      '{"a":{"c":[{"e":1,"f":2}],"d":"x"},"b":1}',
    );
  });

  it("D3.3: a ordem em que os campos chegam não muda o hash (propriedade)", () => {
    const entries = Object.entries(SECTION_9);
    fc.assert(
      fc.property(fc.shuffledSubarray(entries, { minLength: entries.length }), (shuffled) => {
        const fields = Object.fromEntries(shuffled) as unknown as PayloadHashFields;
        expect(payloadHash(fields)).toBe(payloadHash(SECTION_9));
      }),
    );
  });

  it('D2.1 D3.3: "25" e "25.00" → o mesmo hash (normalizado antes)', () => {
    const plain = { ...SECTION_9, money: Money.from({ amount: "25", currency: "BRL" }) };
    expect(payloadHash(plain)).toBe(payloadHash(SECTION_9));
  });

  it("D3.3: referência entra (em ordem) quando vem e é omitida quando ausente", () => {
    const withReference = { ...SECTION_9, referenceExternalTransactionId: "bet-1" };
    const canonicalWithReference = SECTION_9_CANONICAL.replace(
      ',"roundId"',
      ',"referenceExternalTransactionId":"bet-1","roundId"',
    );
    expect(payloadHash(withReference)).toBe(sha256(canonicalWithReference));
    expect(payloadHash(SECTION_9)).toBe(sha256(SECTION_9_CANONICAL));
  });

  it.each([
    ["providerId", { providerId: "provider-b" }],
    ["externalTransactionId", { externalTransactionId: "transaction-124" }],
    ["playerId", { playerId: "outro" }],
    ["walletId", { walletId: "0192f291-27dd-7d3f-8071-5f8685deef38" }],
    ["roundId", { roundId: "round-988" }],
    ["gameId", { gameId: "outro-jogo" }],
    ["kind", { kind: WagerTransactionKind.Win }],
    ["amount", { money: Money.from({ amount: "25.01", currency: "BRL" }) }],
    ["currency", { money: Money.from({ amount: "25.00", currency: "USD" }) }],
  ])("D3.3 R-06-39: %s diferente → hash diferente", (_, override) => {
    expect(payloadHash({ ...SECTION_9, ...override })).not.toBe(payloadHash(SECTION_9));
  });

  it("D3.3: key, messageId, type e occurredAt ficam fora do hash", () => {
    const withTransport = {
      ...SECTION_9,
      idempotencyKey: "provider-a:transaction-123",
      messageId: "msg-123",
      type: "WagerTransactionRequested",
      occurredAt: "2026-07-29T15:00:00.000Z",
    } as PayloadHashFields;
    expect(payloadHash(withTransport)).toBe(payloadHash(SECTION_9));
  });
});

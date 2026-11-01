import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { InvalidCursorError } from "../../../src/modules/wagering/application/errors";
import {
  decodeLedgerCursor,
  encodeLedgerCursor,
} from "../../../src/modules/wagering/application/ledger-cursor";

describe("S3 D6.8: cursor do ledger", () => {
  it("D6.8: ida e volta preserva a versão", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2_147_483_647 }), (version) => {
        expect(decodeLedgerCursor(encodeLedgerCursor(version))).toBe(version);
      }),
    );
  });

  it("D6.8: o cursor é base64url (opaco, seguro em query string)", () => {
    expect(encodeLedgerCursor(42)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ["vazio", ""],
    ["fora do base64url", "não+é/base64"],
    ["não é número", Buffer.from("abc").toString("base64url")],
    ["zero", Buffer.from("0").toString("base64url")],
    ["negativo", Buffer.from("-3").toString("base64url")],
    ["decimal", Buffer.from("1.5").toString("base64url")],
    ["acima de int4", Buffer.from("2147483648").toString("base64url")],
  ])("D6.8 D16.2: cursor %s → InvalidCursorError", (_, cursor) => {
    expect(() => decodeLedgerCursor(cursor)).toThrow(InvalidCursorError);
  });
});

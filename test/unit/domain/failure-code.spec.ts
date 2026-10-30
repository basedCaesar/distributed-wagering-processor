import { describe, expect, it } from "bun:test";
import {
  FAILURE_CODES,
  FailureCode,
  REFERENCE_SCOPE_FIELDS,
} from "../../../src/modules/wagering/domain/failure-code";

describe("FailureCode", () => {
  it("D5 D14.1 R-07-30 R-07-31: lista exata e estável de códigos", () => {
    expect<string[]>([...FAILURE_CODES].sort()).toEqual(
      [
        "INSUFFICIENT_FUNDS",
        "INSUFFICIENT_FUNDS_FOR_REVERSAL",
        "CURRENCY_MISMATCH",
        "WALLET_PLAYER_MISMATCH",
        "REFERENCE_NOT_FOUND",
        "REFERENCE_SCOPE_MISMATCH",
        "REFERENCE_KIND_NOT_ALLOWED",
        "REFERENCE_NOT_PROCESSED",
        "REFERENCE_ALREADY_REVERSED",
        "AMOUNT_MISMATCH",
        "BALANCE_LIMIT_EXCEEDED",
        "PROCESSING_FAILED",
      ].sort(),
    );
  });

  it("R-07-14: código de reversão sem saldo é distinto do de aposta sem saldo", () => {
    expect(FailureCode.InsufficientFundsForReversal).not.toBe(
      FailureCode.InsufficientFunds,
    );
  });

  it("D14.3: campos de escopo da referência", () => {
    expect<string[]>([...REFERENCE_SCOPE_FIELDS].sort()).toEqual(
      ["CURRENCY", "PLAYER", "ROUND", "WALLET"].sort(),
    );
  });
});

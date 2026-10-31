import { describe, expect, it } from "bun:test";
import { PostgreSqlPlatform } from "@mikro-orm/postgresql";
import {
  DecimalAmountType,
  InvalidDecimalAmountError,
} from "../../../src/shared/orm/decimal-amount.type";

const platform = new PostgreSqlPlatform();
const type = new DecimalAmountType();

// 9007199254740993 centavos > 2^53: como number, viraria ...992 ou ...994.
const BEYOND_FLOAT = "90071992547409.93";

describe("S2 D2.4 D7.1: tipo customizado de valor (numeric(20,2) como string)", () => {
  it("D2.4: grava e lê a string sem passar por number", () => {
    expect(type.convertToDatabaseValue(BEYOND_FLOAT, platform)).toBe(
      BEYOND_FLOAT,
    );
    expect(type.convertToJSValue(BEYOND_FLOAT, platform)).toBe(BEYOND_FLOAT);
  });

  it("D2.4: aceita negativo (diferença da reconciliação, D2.6) e zero", () => {
    expect(type.convertToDatabaseValue("-5.00", platform)).toBe("-5.00");
    expect(type.convertToJSValue("0.00", platform)).toBe("0.00");
  });

  it("R-05-01 D2.4: number na gravação lança erro", () => {
    expect(() =>
      type.convertToDatabaseValue(25 as unknown as string, platform),
    ).toThrow(InvalidDecimalAmountError);
  });

  it("R-05-01 D2.4: number vindo do driver lança erro", () => {
    expect(() =>
      type.convertToJSValue(25.5 as unknown as string, platform),
    ).toThrow(InvalidDecimalAmountError);
  });

  it("D2.2: string fora de 2 casas lança erro (nada é arredondado)", () => {
    for (const bad of ["25", "25.0", "25.001", "1e3", "", " 1.00", "NaN"]) {
      expect(() => type.convertToDatabaseValue(bad, platform)).toThrow(
        InvalidDecimalAmountError,
      );
    }
  });

  it("D2.4: coluna numeric(20,2)", () => {
    expect(type.getColumnType()).toBe("numeric(20,2)");
  });
});

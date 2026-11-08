import { describe, expect, it } from "bun:test";
import { centsOf, coveredAmount, formatCents } from "../../../load/lib/money";

/**
 * D2 (CLAUDE.md): dinheiro nunca em `number`, também no `test:load`. Os
 * valores da carga ficam em centavos `bigint`, como no domínio.
 */

describe("D2: dinheiro da carga em centavos bigint", () => {
  it("D2: '0.00' com 2 casas vira centavos bigint e volta igual", () => {
    expect(centsOf("5.00")).toBe(500n);
    expect(centsOf("0.05")).toBe(5n);
    expect(formatCents(500n)).toBe("5.00");
    expect(formatCents(5n)).toBe("0.05");
    expect(formatCents(0n)).toBe("0.00");
  });

  it("D2: valor fora do formato de 2 casas → erro (nada é arredondado)", () => {
    for (const amount of ["5", "5.0", "5.001", "-1.00", "1e3", ""]) {
      expect(() => centsOf(amount)).toThrow();
    }
    expect(() => formatCents(-1n)).toThrow();
  });

  it("D2: valores acima de 2^53 centavos ficam exatos (number perderia a última casa)", () => {
    const big = centsOf("999999999999.99") * 1000n;
    expect(formatCents(big)).toBe("999999999999990.00");
    expect(formatCents(centsOf("999999999999.99") * 1001n)).toBe("1000999999999989.99");
  });

  it("D26.2: valor que cobre uma fração das operações, arredondando a contagem para baixo", () => {
    // 300 × 7/10 = 210 BETs de 1.00 → 210.00.
    expect(coveredAmount(300, { numerator: 7, denominator: 10 }, "1.00")).toBe("210.00");
    // 15 × 7/10 = 10,5 → 10 BETs de 2.50 → 25.00.
    expect(coveredAmount(15, { numerator: 7, denominator: 10 }, "2.50")).toBe("25.00");
  });

  it("D26.2: contagem não inteira ou negativa → erro", () => {
    expect(() => coveredAmount(1.5, { numerator: 7, denominator: 10 }, "1.00")).toThrow();
    expect(() => coveredAmount(-1, { numerator: 7, denominator: 10 }, "1.00")).toThrow();
  });
});

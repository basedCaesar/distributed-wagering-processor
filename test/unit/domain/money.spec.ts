import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import {
  CurrencyMismatchError,
  InvalidMoneyError,
} from "../../../src/modules/wagering/domain/domain-error";
import { Money } from "../../../src/modules/wagering/domain/money";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

/** Valor de entrada válido: até 12 dígitos inteiros e 0 a 2 casas. */
const inputAmount = fc
  .tuple(
    fc.bigInt({ min: 0n, max: 999_999_999_999n }),
    fc.constantFrom("", ".0", ".5", ".05", ".10", ".99"),
  )
  .map(([int, frac]) => `${int}${frac}`);

const cents = fc.bigInt({ min: -(10n ** 17n), max: 10n ** 17n });
const fromCents = (value: bigint) => {
  const abs = value < 0n ? -value : value;
  const digits = abs.toString().padStart(3, "0");
  const amount = `${value < 0n ? "-" : ""}${digits.slice(0, -2)}.${digits.slice(-2)}`;
  return Money.rehydrate({ amount, currency: "BRL" });
};

describe("Money: entrada (Money.from)", () => {
  it("R-06-12 D2.1: '25', '25.5' e '25.50' normalizam para 2 casas", () => {
    expect(brl("25").toString()).toBe("25.00");
    expect(brl("25.5").toString()).toBe("25.50");
    expect(brl("25.50").toString()).toBe("25.50");
    expect(brl("0.05").toString()).toBe("0.05");
    expect(brl("0").toString()).toBe("0.00");
  });

  it("R-06-12 D2.1: '25' e '25.00' são o mesmo valor", () => {
    expect(brl("25").equals(brl("25.00"))).toBe(true);
  });

  it("R-06-18: toJSON devolve { amount, currency } com amount string de 2 casas", () => {
    expect(brl("25").toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
    expect(JSON.stringify(brl("1.5"))).toBe(
      '{"amount":"1.50","currency":"BRL"}',
    );
  });

  it.each([
    ["vazio", ""],
    ["só espaço", " "],
    ["espaço à esquerda", " 1.00"],
    ["espaço à direita", "1.00 "],
    ["sinal negativo", "-1.00"],
    ["sinal positivo", "+1.00"],
    ["notação científica", "1e3"],
    ["notação científica com casas", "1.5E2"],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["-Infinity", "-Infinity"],
    ["zero à esquerda", "01.00"],
    ["zeros à esquerda", "00"],
    ["mais de 2 casas", "1.001"],
    ["3 casas zeradas", "1.000"],
    ["ponto sem casas", "1."],
    ["casas sem inteiro", ".50"],
    ["vírgula decimal", "1,50"],
    ["hexadecimal", "0x10"],
    ["separador de milhar", "1_000"],
    ["13 dígitos inteiros", "1000000000000"],
  ])("R-06-14 D2.2: rejeita %s (%p)", (_label, amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  it("D2.1: aceita até 12 dígitos inteiros", () => {
    expect(brl("999999999999.99").toString()).toBe("999999999999.99");
  });

  it.each(["", "brl", "BR", "BRLL", "R$", "12A"])(
    "D14.7: rejeita moeda com formato inválido (%p)",
    (currency) => {
      expect(() => Money.from({ amount: "1.00", currency })).toThrow(
        InvalidMoneyError,
      );
    },
  );

  it("D14.7: aceita qualquer código de 3 letras maiúsculas (a lista configurada é checada no contrato)", () => {
    expect(Money.from({ amount: "1", currency: "USD" }).currency).toBe("USD");
    expect(Money.from({ amount: "1", currency: "EUR" }).currency).toBe("EUR");
  });

  it("R-06-14: rejeita amount que não é string", () => {
    expect(() =>
      Money.from({ amount: 25 as unknown as string, currency: "BRL" }),
    ).toThrow(InvalidMoneyError);
  });
});

describe("Money: sem arredondamento", () => {
  it("R-13-U1 D2.2: 3 casas é rejeitado, nunca arredondado", () => {
    expect(() => brl("0.105")).toThrow(InvalidMoneyError);
    expect(() => brl("0.999")).toThrow(InvalidMoneyError);
  });

  it("R-13-U1 D2.2: 0.10 + 0.20 = 0.30 exato", () => {
    expect(brl("0.10").add(brl("0.20")).toString()).toBe("0.30");
    expect(brl("0.10").add(brl("0.20")).equals(brl("0.30"))).toBe(true);
  });

  it("R-13-U1 D2.4: valores grandes não perdem centavos", () => {
    const big = brl("999999999999.99");
    expect(big.add(brl("0.01")).toString()).toBe("1000000000000.00");
    expect(big.add(big).toString()).toBe("1999999999999.98");
  });

  it("R-13-U1 D2.2 (propriedade): from(x).toString() só acrescenta zeros, nunca muda o valor", () => {
    fc.assert(
      fc.property(inputAmount, (amount) => {
        const out = brl(amount).toString();
        const [int, frac = ""] = amount.split(".");
        expect(out).toBe(`${int}.${frac.padEnd(2, "0")}`);
      }),
    );
  });
});

describe("Money: aritmética e moeda", () => {
  it("R-06-11: operações devolvem nova instância e não mudam a original", () => {
    const a = brl("10.00");
    const b = brl("3.00");
    const sum = a.add(b);
    const diff = a.subtract(b);
    const neg = a.negate();

    expect(sum).not.toBe(a);
    expect(diff).not.toBe(a);
    expect(neg).not.toBe(a);
    expect(a.toString()).toBe("10.00");
    expect(b.toString()).toBe("3.00");
    expect(Object.isFrozen(a)).toBe(true);
  });

  it("R-06-13 R-13-U4: add, subtract, isLessThan e equals entre moedas diferentes lançam CurrencyMismatchError", () => {
    const real = brl("1.00");
    const dollar = Money.from({ amount: "1.00", currency: "USD" });

    expect(() => real.add(dollar)).toThrow(CurrencyMismatchError);
    expect(() => real.subtract(dollar)).toThrow(CurrencyMismatchError);
    expect(() => real.isLessThan(dollar)).toThrow(CurrencyMismatchError);
    expect(() => real.equals(dollar)).toThrow(CurrencyMismatchError);
  });

  it("D2.6: subtract e negate permitem negativo internamente", () => {
    expect(brl("1.00").subtract(brl("6.00")).toString()).toBe("-5.00");
    expect(brl("5.00").negate().toString()).toBe("-5.00");
    expect(brl("5.00").negate().isNegative()).toBe(true);
    expect(brl("0").negate().toString()).toBe("0.00");
  });

  it("R-06-10 D2.6: isZero, isPositive, isNegative, isLessThan", () => {
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(Money.zero("BRL").toString()).toBe("0.00");
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("0").isPositive()).toBe(false);
    expect(brl("0").isNegative()).toBe(false);
    expect(brl("1.99").isLessThan(brl("2.00"))).toBe(true);
    expect(brl("2.00").isLessThan(brl("2.00"))).toBe(false);
  });

  it("D2.4: hasMoreIntegerDigitsThan conta dígitos inteiros do valor absoluto", () => {
    expect(brl("999999999999.99").hasMoreIntegerDigitsThan(12n)).toBe(false);
    expect(
      brl("999999999999.99").add(brl("0.01")).hasMoreIntegerDigitsThan(12n),
    ).toBe(true);
    expect(brl("100").negate().hasMoreIntegerDigitsThan(2n)).toBe(true);
  });

  it("D2.4 (propriedade): soma é comutativa e associativa, e a + b − b = a", () => {
    fc.assert(
      fc.property(cents, cents, cents, (x, y, z) => {
        const [a, b, c] = [fromCents(x), fromCents(y), fromCents(z)];
        expect(a.add(b).equals(b.add(a))).toBe(true);
        expect(
          a
            .add(b)
            .add(c)
            .equals(a.add(b.add(c))),
        ).toBe(true);
        expect(a.add(b).subtract(b).equals(a)).toBe(true);
        expect(a.add(a.negate()).isZero()).toBe(true);
      }),
    );
  });
});

describe("Money: reconstrução interna (Money.rehydrate)", () => {
  it("D2.4 D2.6: lê o formato do banco (2 casas, com sinal)", () => {
    expect(
      Money.rehydrate({ amount: "-5.00", currency: "BRL" }).toString(),
    ).toBe("-5.00");
    expect(
      Money.rehydrate({
        amount: "999999999999999999.99",
        currency: "BRL",
      }).toString(),
    ).toBe("999999999999999999.99");
  });

  it.each(["5", "5.0", "5.000", "", "1e3", "-0.00", "+5.00", "05.00"])(
    "D2.4: rejeita %p (o banco sempre devolve 2 casas)",
    (amount) => {
      expect(() => Money.rehydrate({ amount, currency: "BRL" })).toThrow(
        InvalidMoneyError,
      );
    },
  );

  it("D2.4 (propriedade): rehydrate(toString(x)) = x", () => {
    fc.assert(
      fc.property(cents, (x) => {
        const money = fromCents(x);
        const back = Money.rehydrate(money.toJSON());
        expect(back.equals(money)).toBe(true);
        expect(back.toString()).toBe(money.toString());
      }),
    );
  });
});

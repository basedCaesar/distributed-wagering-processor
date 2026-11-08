import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { InvalidPostingError } from "../../../src/modules/accounting/domain/accounting-error";
import { Amount } from "../../../src/modules/accounting/domain/amount";
import { AccountCode } from "../../../src/modules/accounting/domain/chart-of-accounts";
import {
  JournalEntry,
  type LineDirection,
  type PostJournalEntryProps,
} from "../../../src/modules/accounting/domain/journal-entry";

const brl = (amount: string) => Amount.parse({ amount, currency: "BRL" });

function post(kind: string, walletDirection: LineDirection, amount = brl("25.00")): JournalEntry {
  const props: PostJournalEntryProps = {
    id: Bun.randomUUIDv7(),
    transactionId: Bun.randomUUIDv7(),
    walletId: Bun.randomUUIDv7(),
    walletVersion: 2,
    kind,
    walletDirection,
    amount,
  };
  return JournalEntry.post(props);
}

/** As linhas como [conta, direção, valor], na ordem do lançamento. */
const linesOf = (entry: JournalEntry) =>
  entry.lines.map((line) => [line.account, line.direction, line.amount.toString(), line.amount.currency]);

describe("D27.2: cada kind vira o lançamento do plano de contas", () => {
  it.each([
    ["OPENING", "CREDIT", AccountCode.HouseOpeningFunds, AccountCode.PlayerWallet],
    ["BET", "DEBIT", AccountCode.PlayerWallet, AccountCode.HouseWagersReceived],
    ["WIN", "CREDIT", AccountCode.HousePayouts, AccountCode.PlayerWallet],
    ["REFUND", "CREDIT", AccountCode.HouseRefunds, AccountCode.PlayerWallet],
    ["ROLLBACK", "CREDIT", AccountCode.HouseRollbacks, AccountCode.PlayerWallet],
    ["ROLLBACK", "DEBIT", AccountCode.PlayerWallet, AccountCode.HouseRollbacks],
  ] as const)("§6.4 D27.2: %s com %s na wallet → débito %s, crédito %s", (kind, direction, debit, credit) => {
    const entry = post(kind, direction);

    expect(linesOf(entry)).toEqual([
      [debit, "DEBIT", "25.00", "BRL"],
      [credit, "CREDIT", "25.00", "BRL"],
    ]);
    expect(entry.isBalanced()).toBe(true);
    expect(entry.currency).toBe("BRL");
  });

  it("D27.2: a linha da conta da wallet tem a direção do WalletBalanceChanged", () => {
    for (const [kind, direction] of [
      ["BET", "DEBIT"],
      ["WIN", "CREDIT"],
      ["ROLLBACK", "DEBIT"],
      ["ROLLBACK", "CREDIT"],
    ] as const) {
      const player = post(kind, direction).lines.filter((line) => line.account === AccountCode.PlayerWallet);
      expect({ kind, directions: player.map((line) => line.direction) }).toEqual({ kind, directions: [direction] });
    }
  });

  it.each([
    ["BET", "CREDIT"],
    ["WIN", "DEBIT"],
    ["REFUND", "DEBIT"],
    ["OPENING", "DEBIT"],
    ["LOSS", "DEBIT"],
    ["LOSS", "CREDIT"],
    ["DEPOSIT", "CREDIT"],
  ] as const)("D27.2: %s com %s na wallet → InvalidPostingError (permanente)", (kind, direction) => {
    expect(() => post(kind, direction)).toThrow(InvalidPostingError);
  });

  it("D27.2: valor zero não gera lançamento → InvalidPostingError", () => {
    expect(() => post("BET", "DEBIT", brl("0.00"))).toThrow(InvalidPostingError);
  });

  it("§6.4 D27.2: o lançamento é imutável (estrutura congelada)", () => {
    const entry = post("BET", "DEBIT");

    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.lines)).toBe(true);
    expect(entry.lines.every((line) => Object.isFrozen(line))).toBe(true);
  });
});

const postable = fc.constantFrom(
  ["OPENING", "CREDIT"],
  ["BET", "DEBIT"],
  ["WIN", "CREDIT"],
  ["REFUND", "CREDIT"],
  ["ROLLBACK", "CREDIT"],
  ["ROLLBACK", "DEBIT"],
) as fc.Arbitrary<[string, LineDirection]>;

/** Centavos de 1 até o maior valor de 12 dígitos inteiros (D2), como string decimal. */
const cents = fc.bigInt({ min: 1n, max: 999_999_999_999_99n });
const decimal = (value: bigint) => `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;

describe("D27.2 D27.3: propriedades de todo lançamento válido", () => {
  it("D27.2: qualquer kind postável e qualquer valor → balanceado, 2 linhas, 1 linha da wallet, valores > 0, uma moeda", () => {
    fc.assert(
      fc.property(postable, cents, fc.constantFrom("BRL", "USD"), ([kind, direction], value, currency) => {
        const amount = Amount.parse({ amount: decimal(value), currency });
        const entry = post(kind, direction, amount);

        expect(entry.isBalanced()).toBe(true);
        expect(entry.lines).toHaveLength(2);
        expect(entry.lines.filter((line) => line.account === AccountCode.PlayerWallet)).toHaveLength(1);
        expect(entry.lines.every((line) => line.amount.isPositive())).toBe(true);
        expect(entry.lines.every((line) => line.amount.currency === currency)).toBe(true);
        expect(entry.lines.map((line) => line.amount.toString())).toEqual([decimal(value), decimal(value)]);
      }),
    );
  });
});

describe("D27.2: Amount (centavos bigint, sem number)", () => {
  it.each([
    ["0.00", 0n],
    ["25.00", 2500n],
    ["0.01", 1n],
    ["999999999999.99", 99_999_999_999_999n],
  ])("D2 D27.2: %s → %p centavos, e volta igual", (amount, expected) => {
    const parsed = Amount.parse({ amount, currency: "BRL" });

    expect(parsed.cents).toBe(expected);
    expect(parsed.toString()).toBe(amount);
  });

  it.each(["25", "25.0", "25.000", "-1.00", "1e3", "01.00", "1000000000000.00", " 1.00", "abc"])(
    "D2 D27.2: %p fora do formato do MoneyProps → erro",
    (amount) => {
      expect(() => Amount.parse({ amount, currency: "BRL" })).toThrow();
    },
  );

  it("D2 D27.2: moeda fora de 3 letras maiúsculas → erro", () => {
    expect(() => Amount.parse({ amount: "1.00", currency: "brl" })).toThrow();
  });

  it("D2 D27.2: soma e subtração em centavos; resultado negativo só na subtração", () => {
    const a = brl("10.05");
    const b = brl("20.10");

    expect(a.plus(b).toString()).toBe("30.15");
    expect(a.minus(b).toString()).toBe("-10.05");
    expect(a.minus(a).isZero()).toBe(true);
    expect(a.equals(brl("10.05"))).toBe(true);
  });

  it("D2 D27.2: operar moedas diferentes → erro", () => {
    expect(() => brl("1.00").plus(Amount.parse({ amount: "1.00", currency: "USD" }))).toThrow();
  });
});

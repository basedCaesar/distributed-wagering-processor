import { describe, expect, it } from "bun:test";
import {
  CurrencyMismatchError,
  InvalidLedgerEntryError,
} from "../../../src/modules/wagering/domain/domain-error";
import { Money } from "../../../src/modules/wagering/domain/money";
import {
  type CreateLedgerEntryProps,
  LedgerDirection,
  WalletLedgerEntry,
} from "../../../src/modules/wagering/domain/wallet-ledger-entry";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const at = new Date("2026-10-30T12:00:00.000Z");

const props = (
  overrides: Partial<CreateLedgerEntryProps> = {},
): CreateLedgerEntryProps => ({
  id: "entry-1",
  walletId: "wallet-1",
  transactionId: "tx-1",
  direction: LedgerDirection.Debit,
  money: brl("25.00"),
  balanceBefore: brl("100.00"),
  balanceAfter: brl("75.00"),
  walletVersion: 2,
  createdAt: at,
  ...overrides,
});

describe("WalletLedgerEntry", () => {
  it("R-06-40: débito e crédito balanceados são criados", () => {
    const debit = WalletLedgerEntry.create(props());
    const credit = WalletLedgerEntry.create(
      props({
        direction: LedgerDirection.Credit,
        balanceAfter: brl("125.00"),
      }),
    );

    expect(debit.isBalanced()).toBe(true);
    expect(credit.isBalanced()).toBe(true);
    expect(debit.walletVersion).toBe(2);
  });

  it.each([
    ["débito com saldo final errado", { balanceAfter: brl("76.00") }],
    [
      "crédito com saldo final de débito",
      { direction: LedgerDirection.Credit },
    ],
  ])("R-06-41: create rejeita aritmética errada (%s)", (_label, override) => {
    expect(() => WalletLedgerEntry.create(props(override))).toThrow(
      InvalidLedgerEntryError,
    );
  });

  it("R-06-23 D7.3: create rejeita saldo final negativo", () => {
    expect(() =>
      WalletLedgerEntry.create(
        props({
          balanceBefore: brl("10.00"),
          balanceAfter: brl("15.00").negate(),
        }),
      ),
    ).toThrow(InvalidLedgerEntryError);
  });

  it("D2.3: create rejeita lançamento de valor zero", () => {
    expect(() =>
      WalletLedgerEntry.create(
        props({ money: brl("0"), balanceAfter: brl("100.00") }),
      ),
    ).toThrow(InvalidLedgerEntryError);
  });

  it("D6.2: create rejeita walletVersion menor que 1", () => {
    expect(() => WalletLedgerEntry.create(props({ walletVersion: 0 }))).toThrow(
      InvalidLedgerEntryError,
    );
  });

  it("R-06-26: create rejeita moedas misturadas", () => {
    expect(() =>
      WalletLedgerEntry.create(
        props({ money: Money.from({ amount: "25.00", currency: "USD" }) }),
      ),
    ).toThrow(CurrencyMismatchError);
  });

  it("R-06-41: imutabilidade estrutural — atribuir a um campo lança", () => {
    const entry = WalletLedgerEntry.create(props());
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { balanceAfter: Money }).balanceAfter =
        brl("1000.00");
    }).toThrow(TypeError);
    expect(entry.balanceAfter.toString()).toBe("75.00");
  });

  it("R-06-03: rehydrate reconstrói sem revalidar", () => {
    const entry = WalletLedgerEntry.rehydrate(
      props({ balanceAfter: brl("1.00") }),
    );
    expect(entry.isBalanced()).toBe(false);
    expect(Object.isFrozen(entry)).toBe(true);
  });
});

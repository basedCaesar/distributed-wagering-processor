import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import {
  BalanceLimitExceededError,
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidWalletOperationError,
} from "../../../src/modules/wagering/domain/domain-error";
import { Money } from "../../../src/modules/wagering/domain/money";
import { Wallet } from "../../../src/modules/wagering/domain/wallet";
import {
  LedgerDirection,
  type WalletLedgerEntry,
} from "../../../src/modules/wagering/domain/wallet-ledger-entry";
import { expectLedgerMatchesBalances } from "../../support/ledger-invariant";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const t0 = new Date("2026-10-30T12:00:00.000Z");
const t1 = new Date("2026-10-30T12:00:01.000Z");

function openWallet(initial: string) {
  return Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: brl(initial),
    openingTransactionId: "tx-opening",
    openingEntryId: "entry-opening",
    at: t0,
  });
}

const move = (amount: string, n = 1) => ({
  money: brl(amount),
  transactionId: `tx-${n}`,
  entryId: `entry-${n}`,
  at: t1,
});

describe("Wallet.open", () => {
  it("R-06-27 D6.2: abre com saldo → version 1 e lançamento OPENING com walletVersion 1", () => {
    const { wallet, openingEntry } = openWallet("1000.00");

    expect(wallet.id).toBe("wallet-1");
    expect(wallet.playerId).toBe("player-1");
    expect(wallet.currency).toBe("BRL");
    expect(wallet.balance.toString()).toBe("1000.00");
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt).toEqual(t0);
    expect(wallet.updatedAt).toEqual(t0);

    expect(openingEntry).toBeDefined();
    expect(openingEntry?.transactionId).toBe("tx-opening");
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.toString()).toBe("0.00");
    expect(openingEntry?.balanceAfter.toString()).toBe("1000.00");
    expect(openingEntry?.walletVersion).toBe(1);

    expectLedgerMatchesBalances({
      wallet,
      entries: openingEntry ? [openingEntry] : [],
    });
  });

  it("R-06-27 D2.3 D6.2: abre com 0 → version 1 e sem lançamento", () => {
    const { wallet, openingEntry } = openWallet("0");

    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
    expectLedgerMatchesBalances({ wallet, entries: [] });
  });

  it("D2.3 D2.6: abre com saldo negativo lança", () => {
    expect(() =>
      Wallet.open({
        id: "wallet-1",
        playerId: "player-1",
        initialBalance: brl("10.00").negate(),
        openingTransactionId: "tx-opening",
        openingEntryId: "entry-opening",
        at: t0,
      }),
    ).toThrow(InvalidWalletOperationError);
  });

  it("D6.2: o primeiro movimento depois da OPENING tem version 2", () => {
    const { wallet, openingEntry } = openWallet("100.00");
    const entry = wallet.debit(move("10.00"));

    expect(entry.walletVersion).toBe(2);
    expect(wallet.version).toBe(2);
    expectLedgerMatchesBalances({
      wallet,
      entries: [openingEntry as WalletLedgerEntry, entry],
    });
  });
});

describe("Wallet.debit e Wallet.credit", () => {
  it("R-06-21 D6.5: debit devolve o lançamento DEBIT e sobe a version", () => {
    const { wallet, openingEntry } = openWallet("100.00");
    const entry = wallet.debit(move("25.00"));

    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.walletId).toBe("wallet-1");
    expect(entry.transactionId).toBe("tx-1");
    expect(entry.id).toBe("entry-1");
    expect(entry.money.toString()).toBe("25.00");
    expect(entry.balanceBefore.toString()).toBe("100.00");
    expect(entry.balanceAfter.toString()).toBe("75.00");
    expect(entry.createdAt).toEqual(t1);
    expect(wallet.balance.toString()).toBe("75.00");
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(t1);
    expectLedgerMatchesBalances({
      wallet,
      entries: [openingEntry as WalletLedgerEntry, entry],
    });
  });

  it("R-06-21 D6.5: credit devolve o lançamento CREDIT e sobe a version", () => {
    const { wallet, openingEntry } = openWallet("100.00");
    const entry = wallet.credit(move("25.00"));

    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceAfter.toString()).toBe("125.00");
    expect(wallet.balance.toString()).toBe("125.00");
    expect(wallet.version).toBe(2);
    expectLedgerMatchesBalances({
      wallet,
      entries: [openingEntry as WalletLedgerEntry, entry],
    });
  });

  it("R-06-23: debit que deixaria saldo negativo lança e não muda o estado", () => {
    const { wallet, openingEntry } = openWallet("100.00");

    expect(wallet.canDebit(brl("100.01"))).toBe(false);
    expect(() => wallet.debit(move("100.01"))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe("100.00");
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(t0);
    expectLedgerMatchesBalances({
      wallet,
      entries: [openingEntry as WalletLedgerEntry],
    });
  });

  it("R-06-23: debit do saldo inteiro deixa zero", () => {
    const { wallet, openingEntry } = openWallet("100.00");
    const entry = wallet.debit(move("100.00"));

    expect(wallet.balance.isZero()).toBe(true);
    expectLedgerMatchesBalances({
      wallet,
      entries: [openingEntry as WalletLedgerEntry, entry],
    });
  });

  it("R-06-26 R-13-U4: operação em outra moeda lança e não muda o estado", () => {
    const { wallet, openingEntry } = openWallet("100.00");
    const usd = {
      ...move("1.00"),
      money: Money.from({ amount: "1.00", currency: "USD" }),
    };

    expect(() => wallet.debit(usd)).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(usd)).toThrow(CurrencyMismatchError);
    expect(wallet.balance.toString()).toBe("100.00");
    expect(wallet.version).toBe(1);
    expectLedgerMatchesBalances({
      wallet,
      entries: [openingEntry as WalletLedgerEntry],
    });
  });

  it("R-06-27 D2.3: movimento de valor zero lança (version só muda quando o saldo muda)", () => {
    const { wallet } = openWallet("100.00");

    expect(() => wallet.debit(move("0"))).toThrow(InvalidWalletOperationError);
    expect(() => wallet.credit(move("0"))).toThrow(InvalidWalletOperationError);
    expect(wallet.version).toBe(1);
  });

  it("D2.4: crédito que passaria de 15 dígitos inteiros lança BalanceLimitExceededError", () => {
    const wallet = Wallet.rehydrate({
      id: "wallet-1",
      playerId: "player-1",
      currency: "BRL",
      balance: Money.rehydrate({
        amount: "999999999999999.00",
        currency: "BRL",
      }),
      version: 7,
      createdAt: t0,
      updatedAt: t0,
    });

    expect(wallet.canCredit(brl("0.99"))).toBe(true);
    expect(wallet.canCredit(brl("1.00"))).toBe(false);
    expect(() => wallet.credit(move("1.00"))).toThrow(
      BalanceLimitExceededError,
    );
    expect(wallet.version).toBe(7);

    wallet.credit(move("0.99"));
    expect(wallet.balance.toString()).toBe("999999999999999.99");
    expect(wallet.version).toBe(8);
  });
});

describe("Wallet.rehydrate", () => {
  it("R-06-03 R-06-20b: reconstrói o estado sem revalidar", () => {
    const wallet = Wallet.rehydrate({
      id: "wallet-9",
      playerId: "player-9",
      currency: "USD",
      balance: Money.rehydrate({ amount: "12.34", currency: "USD" }),
      version: 42,
      createdAt: t0,
      updatedAt: t1,
    });

    expect(wallet.balance.toString()).toBe("12.34");
    expect(wallet.currency).toBe("USD");
    expect(wallet.version).toBe(42);
    expect(wallet.updatedAt).toEqual(t1);
  });
});

describe("Wallet: invariantes (propriedade)", () => {
  const operation = fc.record({
    direction: fc.constantFrom(LedgerDirection.Debit, LedgerDirection.Credit),
    amount: fc
      .bigInt({ min: 1n, max: 50_000n })
      .map(
        (cents) =>
          `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`,
      ),
  });

  it("R-13-U2 R-06-23 R-06-24 R-06-27: qualquer sequência mantém saldo = Σ lançamentos, saldo ≥ 0 e versões contíguas", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("0", "1.00", "100.00", "250.50"),
        fc.array(operation, { maxLength: 60 }),
        (initial, operations) => {
          const { wallet, openingEntry } = openWallet(initial);
          const entries: WalletLedgerEntry[] = openingEntry
            ? [openingEntry]
            : [];

          operations.forEach((op, i) => {
            const input = move(op.amount, i + 1);
            const versionBefore = wallet.version;
            const balanceBefore = wallet.balance;

            if (op.direction === LedgerDirection.Credit) {
              entries.push(wallet.credit(input));
            } else if (wallet.canDebit(input.money)) {
              entries.push(wallet.debit(input));
            } else {
              expect(() => wallet.debit(input)).toThrow(InsufficientFundsError);
              expect(wallet.version).toBe(versionBefore);
              expect(wallet.balance.equals(balanceBefore)).toBe(true);
              return;
            }
            expect(wallet.version).toBe(versionBefore + 1);
          });

          expectLedgerMatchesBalances({ wallet, entries });
        },
      ),
    );
  });
});

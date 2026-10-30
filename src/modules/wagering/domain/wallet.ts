import {
  BalanceLimitExceededError,
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidWalletOperationError,
} from "./domain-error";
import { Money } from "./money";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry";

/** Teto de saldo: 15 dígitos inteiros (D2.4). */
const BALANCE_INTEGER_DIGITS = 15n;

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  /** Define a moeda da wallet (D6.7). */
  initialBalance: Money;
  /** Usados só quando o saldo inicial é positivo (D2.3). */
  openingTransactionId: string;
  openingEntryId: string;
  at: Date;
}

export interface WalletMovement {
  money: Money;
  transactionId: string;
  entryId: string;
  at: Date;
}

/**
 * Raiz de agregado (D6.5). `debit` e `credit` são o único caminho para
 * mudar o saldo, e sempre devolvem o lançamento (R-06-21, R-06-24).
 * A `version` sobe aqui, uma vez por mudança de saldo; o ORM não a
 * incrementa (D7.2).
 */
export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre com `version` 1 (R-06-27, D6.2). Saldo inicial positivo gera o
   * lançamento da `OPENING` com `walletVersion` 1; zero não gera (D2.3).
   */
  static open(props: OpenWalletProps): {
    wallet: Wallet;
    openingEntry: WalletLedgerEntry | undefined;
  } {
    const { initialBalance, at } = props;
    if (initialBalance.isNegative()) {
      throw new InvalidWalletOperationError("Saldo inicial negativo");
    }
    const wallet = new Wallet(
      props.id,
      props.playerId,
      initialBalance.currency,
      initialBalance,
      1,
      at,
      at,
    );
    if (initialBalance.isZero()) {
      return { wallet, openingEntry: undefined };
    }
    const openingEntry = WalletLedgerEntry.create({
      id: props.openingEntryId,
      walletId: wallet.id,
      transactionId: props.openingTransactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(wallet.currency),
      balanceAfter: initialBalance,
      walletVersion: 1,
      createdAt: at,
    });
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência — não revalida (R-06-03). */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.subtract(money).isNegative();
  }

  canCredit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance
      .add(money)
      .hasMoreIntegerDigitsThan(BALANCE_INTEGER_DIGITS);
  }

  debit(movement: WalletMovement): WalletLedgerEntry {
    this.assertMovement(movement.money);
    if (!this.canDebit(movement.money)) throw new InsufficientFundsError();
    return this.apply(LedgerDirection.Debit, movement);
  }

  credit(movement: WalletMovement): WalletLedgerEntry {
    this.assertMovement(movement.money);
    if (!this.canCredit(movement.money)) throw new BalanceLimitExceededError();
    return this.apply(LedgerDirection.Credit, movement);
  }

  private apply(
    direction: LedgerDirection,
    movement: WalletMovement,
  ): WalletLedgerEntry {
    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Credit
        ? balanceBefore.add(movement.money)
        : balanceBefore.subtract(movement.money);
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore,
      balanceAfter,
      walletVersion: this._version + 1,
      createdAt: movement.at,
    });
    this._balance = balanceAfter;
    this._version = entry.walletVersion;
    this._updatedAt = movement.at;
    return entry;
  }

  /** Moeda igual (R-06-26) e valor positivo (D2.3: zero não muda saldo). */
  private assertMovement(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidWalletOperationError(
        "Movimento precisa de valor positivo",
      );
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}

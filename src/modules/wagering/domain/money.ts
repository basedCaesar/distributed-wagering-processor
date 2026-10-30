import { CurrencyMismatchError, InvalidMoneyError } from "./domain-error";

/** DTO dos contratos: `{ "amount": "25.00", "currency": "BRL" }` (R-06-18). */
export interface MoneyProps {
  amount: string;
  currency: string;
}

/** Entrada: 0 a 2 casas, até 12 dígitos inteiros, sem sinal (D2.1, D2.2). */
const INPUT_AMOUNT = /^(0|[1-9]\d{0,11})(\.\d{1,2})?$/;
/** Persistência: sempre 2 casas, com sinal opcional (D2.4, D2.6). */
const STORED_AMOUNT = /^-?(0|[1-9]\d*)\.\d{2}$/;
/** Formato ISO-4217; a lista aceita é checada no contrato (D14.7). */
const CURRENCY = /^[A-Z]{3}$/;

/**
 * Dinheiro exato: centavos em `bigint` e moeda (D2.4). Imutável (R-06-11).
 * Nada é arredondado: entradas com mais de 2 casas são rejeitadas (D2.2).
 */
export class Money {
  private constructor(
    private readonly cents: bigint,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** Fábrica de entrada dos contratos: proíbe negativo (R-06-14, D2.6). */
  static from(props: MoneyProps): Money {
    const { amount, currency } = props;
    if (typeof amount !== "string" || !INPUT_AMOUNT.test(amount)) {
      throw new InvalidMoneyError("amount fora do formato de entrada");
    }
    const [integer = "", fraction = ""] = amount.split(".");
    return new Money(
      BigInt(integer + fraction.padEnd(2, "0")),
      Money.checkedCurrency(currency),
    );
  }

  /** Reconstrução do formato persistido (`numeric(20,2)` lido como string). */
  static rehydrate(props: MoneyProps): Money {
    const { amount, currency } = props;
    if (
      typeof amount !== "string" ||
      !STORED_AMOUNT.test(amount) ||
      amount === "-0.00"
    ) {
      throw new InvalidMoneyError("amount fora do formato persistido");
    }
    return new Money(
      BigInt(amount.replace(".", "")),
      Money.checkedCurrency(currency),
    );
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.checkedCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents === other.cents;
  }

  /** O valor absoluto tem mais de `digits` dígitos inteiros? (teto de saldo, D2.4) */
  hasMoreIntegerDigitsThan(digits: bigint): boolean {
    const abs = this.cents < 0n ? -this.cents : this.cents;
    return abs >= 10n ** (digits + 2n);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  /** Sempre 2 casas (R-06-12). */
  toString(): string {
    const abs = this.cents < 0n ? -this.cents : this.cents;
    const digits = abs.toString().padStart(3, "0");
    const sign = this.cents < 0n ? "-" : "";
    return `${sign}${digits.slice(0, -2)}.${digits.slice(-2)}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static checkedCurrency(currency: string): string {
    if (typeof currency !== "string" || !CURRENCY.test(currency)) {
      throw new InvalidMoneyError("currency fora do formato ISO-4217");
    }
    return currency;
  }
}

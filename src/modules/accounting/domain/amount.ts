import { InvalidAmountError } from "./accounting-error";

/** O `MoneyProps` do núcleo: 0 a 12 dígitos inteiros sem zero à esquerda, sempre 2 casas (D2). */
const AMOUNT_FORMAT = /^(0|[1-9][0-9]{0,11})\.([0-9]{2})$/;
const CURRENCY_FORMAT = /^[A-Z]{3}$/;
/** Um total do banco (`numeric::text`): sinal opcional, 2 casas. */
const TOTAL_FORMAT = /^(-?)([0-9]+)\.([0-9]{2})$/;

export interface AmountProps {
  amount: string;
  currency: string;
}

/**
 * Valor do diário em centavos `bigint` (D2, D27.2). Próprio do contexto: o
 * accounting não importa o `Money` do núcleo (D27.8). Pode ficar negativo
 * só como resultado de uma subtração (saldo de conta, diferença).
 */
export class Amount {
  private constructor(
    readonly cents: bigint,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** Lê o `MoneyProps` de um evento (string decimal com 2 casas). */
  static parse(props: AmountProps): Amount {
    const match = AMOUNT_FORMAT.exec(props.amount);
    if (!match) throw new InvalidAmountError("valor fora do formato do MoneyProps");
    if (!CURRENCY_FORMAT.test(props.currency)) throw new InvalidAmountError("moeda fora do formato");
    const [, units = "0", fraction = "00"] = match;
    return new Amount(BigInt(units) * 100n + BigInt(fraction), props.currency);
  }

  /**
   * Lê um total já calculado pelo banco (saldo de conta, Σ do diário):
   * pode ser negativo e passar de 12 dígitos. Nunca para a entrada de um
   * evento, que usa `parse`.
   */
  static parseTotal(value: string, currency: string): Amount {
    const match = TOTAL_FORMAT.exec(value);
    if (!match) throw new InvalidAmountError("total fora do formato decimal com 2 casas");
    if (!CURRENCY_FORMAT.test(currency)) throw new InvalidAmountError("moeda fora do formato");
    const [, sign, units = "0", fraction = "00"] = match;
    const cents = BigInt(units) * 100n + BigInt(fraction);
    return new Amount(sign === "-" ? -cents : cents, currency);
  }

  static zero(currency: string): Amount {
    if (!CURRENCY_FORMAT.test(currency)) throw new InvalidAmountError("moeda fora do formato");
    return new Amount(0n, currency);
  }

  plus(other: Amount): Amount {
    this.assertSameCurrency(other);
    return new Amount(this.cents + other.cents, this.currency);
  }

  minus(other: Amount): Amount {
    this.assertSameCurrency(other);
    return new Amount(this.cents - other.cents, this.currency);
  }

  equals(other: Amount): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  /** String decimal com 2 casas; negativo com sinal. */
  toString(): string {
    const negative = this.cents < 0n;
    const absolute = negative ? -this.cents : this.cents;
    const units = absolute / 100n;
    const fraction = (absolute % 100n).toString().padStart(2, "0");
    return `${negative ? "-" : ""}${units}.${fraction}`;
  }

  toJSON(): AmountProps {
    return { amount: this.toString(), currency: this.currency };
  }

  private assertSameCurrency(other: Amount): void {
    if (other.currency !== this.currency) throw new InvalidAmountError("moedas diferentes");
  }
}

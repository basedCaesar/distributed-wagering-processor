import { type Platform, Type } from "@mikro-orm/core";

/** Sempre 2 casas, sinal opcional (a diferença da reconciliação é com sinal, D2.6). */
const DECIMAL_AMOUNT = /^-?(0|[1-9]\d*)\.\d{2}$/;

export class InvalidDecimalAmountError extends Error {
  constructor(direction: "gravação" | "leitura", value: unknown) {
    super(
      `valor monetário inválido na ${direction}: esperado string com 2 casas, veio ${typeof value}`,
    );
    this.name = "InvalidDecimalAmountError";
  }
}

/**
 * Tipo customizado para valores monetários (D2.4, D7.1): `numeric(20,2)`
 * lido e gravado como string, sem passar por `number`. Um `number` em
 * qualquer direção é bug e lança erro, em vez de perder centavos em
 * silêncio. A moeda fica em outra coluna; o mapper monta o `Money`.
 */
export class DecimalAmountType extends Type<string | null, string | null> {
  override convertToDatabaseValue(
    value: string | null,
    _platform?: Platform,
  ): string | null {
    return DecimalAmountType.checked(value, "gravação");
  }

  override convertToJSValue(
    value: string | null,
    _platform?: Platform,
  ): string | null {
    return DecimalAmountType.checked(value, "leitura");
  }

  override getColumnType(): string {
    return "numeric(20,2)";
  }

  override compareAsType(): string {
    return "string";
  }

  override get runtimeType(): string {
    return "string";
  }

  /** `null` passa: colunas anuláveis, como `balance_after` (D3.5). */
  private static checked(
    value: unknown,
    direction: "gravação" | "leitura",
  ): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== "string" || !DECIMAL_AMOUNT.test(value)) {
      throw new InvalidDecimalAmountError(direction, value);
    }
    return value;
  }
}

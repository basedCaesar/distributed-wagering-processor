/**
 * Dinheiro do `test:load` em centavos `bigint`, como no domínio (D2,
 * CLAUDE.md): nada de `number` nem das funções globais de número.
 * O lint aplica a mesma regra do `domain/` a este arquivo (`biome.json`), e
 * `test/unit/lint-domain-purity.spec.ts` procura os padrões proibidos nele.
 * Código puro: roda no Bun (orquestrador e testes).
 */

const AMOUNT = /^(\d+)\.(\d{2})$/;

/** `"5.00"` → `500n`. Só o formato com 2 casas que a carga manda; nada é arredondado. */
export function centsOf(amount: string): bigint {
  const match = AMOUNT.exec(amount);
  if (match === null) throw new Error(`valor fora do formato 0.00: ${amount}`);
  return BigInt(match[1] as string) * 100n + BigInt(match[2] as string);
}

/** `500n` → `"5.00"`. */
export function formatCents(cents: bigint): string {
  if (cents < 0n) throw new Error("valor negativo não é usado pela carga");
  const reais = cents / 100n;
  const rest = cents % 100n;
  return `${reais}.${rest < 10n ? "0" : ""}${rest}`;
}

export interface Fraction {
  numerator: number;
  denominator: number;
}

/**
 * Valor que cobre a fração `fraction` de `count` operações de `amount` cada:
 * a contagem coberta é arredondada para baixo (D26.2, hot wallet).
 */
export function coveredAmount(count: number, fraction: Fraction, amount: string): string {
  // `BigInt` lança RangeError para não inteiro.
  const total = BigInt(count);
  if (total < 0n) throw new Error(`contagem negativa: ${count}`);
  const covered = (total * BigInt(fraction.numerator)) / BigInt(fraction.denominator);
  return formatCents(covered * centsOf(amount));
}

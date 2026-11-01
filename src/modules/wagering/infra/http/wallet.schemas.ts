import { z } from "zod";
import { InvalidMoneyError } from "../../domain/domain-error";
import { Money } from "../../domain/money";

/** D6.4. */
export const playerIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,128}$/, "playerId: 1 a 128 caracteres [A-Za-z0-9._:-]");

/** D16.8: qualquer versão de UUID. */
export const walletIdSchema = z.uuid("walletId precisa ser UUID");

/**
 * `MoneyProps` de entrada (D2.1, D2.2, D2.5, D14.7): formato pelo
 * `Money.from` (que normaliza para 2 casas) e moeda da lista configurada.
 */
export function moneyInputSchema(currencies: readonly string[]) {
  return z
    .object({ amount: z.string(), currency: z.string() })
    .transform((props, ctx) => {
      if (!currencies.includes(props.currency)) {
        ctx.addIssue({
          code: "custom",
          path: ["currency"],
          message: `moeda fora da lista aceita (${currencies.join(", ")})`,
        });
        return z.NEVER;
      }
      try {
        return Money.from(props);
      } catch (error) {
        if (!(error instanceof InvalidMoneyError)) throw error;
        ctx.addIssue({
          code: "custom",
          path: ["amount"],
          message: "amount: até 12 dígitos inteiros e 2 casas, sem sinal",
        });
        return z.NEVER;
      }
    });
}

export function createWalletSchema(currencies: readonly string[]) {
  return z.object({
    playerId: playerIdSchema,
    // Obrigatório: a moeda da wallet vem dele (D6.7). Saldo ≥ 0 (D2.3).
    initialBalance: moneyInputSchema(currencies),
  });
}

/** D6.8: `limit` 1 a 200, padrão 50. */
export const ledgerQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z
    .string()
    .regex(/^[1-9]\d{0,2}$/, "limit: inteiro de 1 a 200")
    .transform((value) => Number(value))
    .refine((value) => value <= 200, "limit: inteiro de 1 a 200")
    .default(50),
});

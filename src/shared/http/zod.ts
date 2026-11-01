import type { z } from "zod";
import { ValidationError } from "../errors/app-errors";

/**
 * Valida a entrada com zod; falha → `400 VALIDATION_ERROR` (D5). Os
 * detalhes levam só o caminho e a mensagem de cada problema, nunca o valor
 * recebido (D11.1).
 */
export function parseOrThrow<S extends z.ZodType>(
  schema: S,
  input: unknown,
  what: string,
): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new ValidationError(`${what} inválido`, {
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  });
}

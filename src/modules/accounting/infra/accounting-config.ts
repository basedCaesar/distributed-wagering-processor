import { z } from "zod";

const schema = z.object({
  queues: z.object({
    accountingEvents: z.string().min(1, "QUEUE_ACCOUNTING_EVENTS é obrigatório"),
    accountingEventsDlq: z.string().min(1, "QUEUE_ACCOUNTING_EVENTS_DLQ é obrigatório"),
  }),
});

export type AccountingConfig = z.infer<typeof schema>;

/**
 * Config própria do contexto (D27.6): só o `accounting-consumer` a lê. A
 * config comum (`loadConfig`) continua igual. Falha na subida se faltar.
 */
export function loadAccountingConfig(env: Record<string, string | undefined> = process.env): AccountingConfig {
  const result = schema.safeParse({
    queues: {
      accountingEvents: env.QUEUE_ACCOUNTING_EVENTS ?? "",
      accountingEventsDlq: env.QUEUE_ACCOUNTING_EVENTS_DLQ ?? "",
    },
  });
  if (!result.success) {
    throw new Error(`config do accounting inválida: ${result.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return result.data;
}

import { z } from "zod";

const currencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "moeda precisa ter 3 letras (ISO 4217)");

export const configSchema = z.object({
  nodeEnv: z.enum(["development", "test", "production"]).default("development"),
  port: z.coerce.number().int().positive(),
  currencies: z
    .array(currencyCode)
    .min(1, "a lista de moedas não pode ser vazia")
    .default(["BRL", "USD"]),
  aws: z.object({
    region: z.string().min(1),
    endpoint: z.string().min(1),
    sns: z.object({
      wageringEventsTopic: z.string().min(1),
    }),
    queues: z.object({
      wagerTransactions: z.string().min(1),
      wagerTransactionsDlq: z.string().min(1),
      wageringEventsAuditor: z.string().min(1),
    }),
  }),
  healthCheckTimeoutMs: z.coerce.number().int().positive().default(1000),
});

export type AppConfig = z.infer<typeof configSchema>;

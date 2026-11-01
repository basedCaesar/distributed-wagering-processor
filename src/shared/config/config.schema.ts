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
      wageringEventsAuditorDlq: z.string().min(1),
    }),
  }),
  healthCheckTimeoutMs: z.coerce.number().int().positive().default(1000),
  /**
   * Publisher da outbox (D9.6, D20.5): o timeout de uma chamada ao SNS tem
   * de ser menor que o lease, senão uma chamada lenta deixa o lease vencer
   * e outra instância publica de novo.
   */
  outbox: z
    .object({
      leaseMs: z.coerce.number().int().positive().default(30_000),
      snsRequestTimeoutMs: z.coerce.number().int().positive().default(10_000),
    })
    .refine((outbox) => outbox.snsRequestTimeoutMs < outbox.leaseMs, {
      message: "OUTBOX_SNS_REQUEST_TIMEOUT_MS precisa ser menor que OUTBOX_LEASE_MS (D20.5)",
    }),
});

export type AppConfig = z.infer<typeof configSchema>;

import { z } from "zod";
import { LOCK_TIMEOUT_MS, STATEMENT_TIMEOUT_MS } from "../orm/db-session";

/** Pior caso de uma mensagem (D19.6): `lock_timeout` 2 s + `statement_timeout` 5 s. */
const MESSAGE_WORST_CASE_SECONDS = (LOCK_TIMEOUT_MS + STATEMENT_TIMEOUT_MS) / 1000;

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
   * Porta interna do `/metrics`, sem auth, em todo processo (D11.2, D22.1).
   * `0` escolhe uma porta livre: os testes que sobem vários módulos Nest no
   * mesmo processo usam isso.
   */
  metricsPort: z.coerce.number().int().min(0).max(65_535).default(9464),
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
  /** Prazo de uma requisição HTTP (D5, D21.3); também o prazo de drenagem no shutdown (D8.6). */
  http: z.object({
    requestTimeoutMs: z.coerce.number().int().positive().default(10_000),
  }),
  /**
   * `application_name` das conexões ao Postgres (D21.1). Sem valor, cada
   * processo usa o próprio nome. Formato da D6.4, até 63 caracteres (o
   * limite do Postgres), sem espaço: vai no parâmetro de startup.
   */
  dbApplicationName: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,63}$/, "DB_APPLICATION_NAME fora do formato (D21.1)")
    .optional(),
  /**
   * Worker de pendentes (D18.2, D21.6): o lease cobre o lote, cada item
   * esperando até um `lock_timeout` de 2 s. Vencido no meio do lote, o
   * dono do lease (D18.10) evita a tentativa em dobro.
   */
  pending: z
    .object({
      leaseMs: z.coerce.number().int().positive().default(30_000),
      batchSize: z.coerce.number().int().positive().default(10),
    })
    .refine((pending) => pending.batchSize * LOCK_TIMEOUT_MS < pending.leaseMs, {
      message: "PENDING_LEASE_MS precisa cobrir PENDING_BATCH_SIZE × lock_timeout de 2 s (D18.2, D21.6)",
    }),
  /**
   * Consumidor SQS (D19.6, D21.6): a visibilidade cobre o lote de um grupo,
   * cada mensagem até `lock_timeout` + `statement_timeout` (2 s + 5 s).
   * O SQS entrega no máximo 10 mensagens por receive.
   */
  consumer: z
    .object({
      visibilityTimeoutSeconds: z.coerce.number().int().positive().default(120),
      maxMessages: z.coerce.number().int().min(1).max(10).default(10),
    })
    .refine(
      (consumer) => consumer.maxMessages * MESSAGE_WORST_CASE_SECONDS <= consumer.visibilityTimeoutSeconds,
      {
        message:
          "CONSUMER_VISIBILITY_TIMEOUT_S precisa cobrir CONSUMER_MAX_MESSAGES × (2 s + 5 s) (D19.6, D21.6)",
      },
    ),
});

export type AppConfig = z.infer<typeof configSchema>;

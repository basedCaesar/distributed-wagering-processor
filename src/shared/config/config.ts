import { type AppConfig, configSchema } from "./config.schema";

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(`Config inválida: ${message}`);
    this.name = "ConfigValidationError";
  }
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  const parsed = configSchema.safeParse({
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    currencies: env.CURRENCIES?.split(","),
    aws: {
      region: env.AWS_REGION,
      endpoint: env.AWS_ENDPOINT,
      sns: {
        wageringEventsTopic: env.SNS_TOPIC_WAGERING_EVENTS,
      },
      queues: {
        wagerTransactions: env.QUEUE_WAGER_TRANSACTIONS,
        wagerTransactionsDlq: env.QUEUE_WAGER_TRANSACTIONS_DLQ,
        wageringEventsAuditor: env.QUEUE_WAGERING_EVENTS_AUDITOR,
        wageringEventsAuditorDlq: env.QUEUE_WAGERING_EVENTS_AUDITOR_DLQ,
      },
    },
    healthCheckTimeoutMs: env.HEALTH_CHECK_TIMEOUT_MS,
    outbox: {
      leaseMs: env.OUTBOX_LEASE_MS,
      snsRequestTimeoutMs: env.OUTBOX_SNS_REQUEST_TIMEOUT_MS,
    },
  });

  if (!parsed.success) {
    throw new ConfigValidationError(parsed.error.message);
  }

  return parsed.data;
}

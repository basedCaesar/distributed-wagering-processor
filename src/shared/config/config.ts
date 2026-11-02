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
    metricsPort: env.METRICS_PORT,
    outbox: {
      leaseMs: env.OUTBOX_LEASE_MS,
      snsRequestTimeoutMs: env.OUTBOX_SNS_REQUEST_TIMEOUT_MS,
    },
    http: {
      requestTimeoutMs: env.HTTP_REQUEST_TIMEOUT_MS,
    },
    dbApplicationName: env.DB_APPLICATION_NAME || undefined,
    pending: {
      leaseMs: env.PENDING_LEASE_MS,
      batchSize: env.PENDING_BATCH_SIZE,
    },
    consumer: {
      visibilityTimeoutSeconds: env.CONSUMER_VISIBILITY_TIMEOUT_S,
      maxMessages: env.CONSUMER_MAX_MESSAGES,
    },
  });

  if (!parsed.success) {
    throw new ConfigValidationError(parsed.error.message);
  }

  return parsed.data;
}

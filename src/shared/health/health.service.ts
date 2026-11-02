import { Inject, Injectable } from "@nestjs/common";
import type { AppConfig } from "../config/config.schema";
import { APP_CONFIG } from "../config/config.module";
import {
  SECRETS_PROVIDER,
  type SecretsProvider,
} from "../secrets/secrets-provider.port";
import type { HealthCheckResult } from "./health.types";
import { checkPostgres } from "./postgres-health-check";
import { checkSqs } from "./sqs-health-check";

@Injectable()
export class HealthService {
  private shuttingDown = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SECRETS_PROVIDER) private readonly secretsProvider: SecretsProvider,
  ) {}

  /** Shutdown começou (D8.6): a readiness fica falsa de vez. */
  markShuttingDown(): void {
    this.shuttingDown = true;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  async checkReady() {
    if (this.shuttingDown) {
      const skipped: HealthCheckResult = { status: "error", reason: "shutting down" };
      return { postgres: skipped, sqs: skipped, ready: false };
    }
    const credentials = await this.secretsProvider.getDatabaseCredentials();
    const [postgres, sqs] = await Promise.all([
      checkPostgres(credentials, this.config.healthCheckTimeoutMs),
      checkSqs(
        {
          region: this.config.aws.region,
          endpoint: this.config.aws.endpoint,
          queueName: this.config.aws.queues.wagerTransactions,
        },
        this.config.healthCheckTimeoutMs,
      ),
    ]);

    return {
      postgres,
      sqs,
      ready: postgres.status === "ok" && sqs.status === "ok",
    };
  }
}

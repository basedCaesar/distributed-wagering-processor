import { Inject, Injectable } from "@nestjs/common";
import type { AppConfig } from "../config/config.schema";
import { APP_CONFIG } from "../config/config.module";
import {
  SECRETS_PROVIDER,
  type SecretsProvider,
} from "../secrets/secrets-provider.port";
import { checkPostgres } from "./postgres-health-check";
import { checkSqs } from "./sqs-health-check";

@Injectable()
export class HealthService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SECRETS_PROVIDER) private readonly secretsProvider: SecretsProvider,
  ) {}

  async checkReady() {
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

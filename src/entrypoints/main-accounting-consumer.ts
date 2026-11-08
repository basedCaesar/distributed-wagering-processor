import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AccountingConsumerAppModule } from "../app/accounting-consumer.module";
import { AccountingConsumer } from "../modules/accounting/infra/messaging/accounting-consumer";
import { exitOnBootstrapFailure } from "../shared/errors/bootstrap-failure";
import { logger } from "../shared/logger/logger";

/**
 * Processo `accounting-consumer` (D27.6). `SIGTERM`/`SIGINT`: o mesmo
 * `stop()` do consumidor (D8.5, D19.9).
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AccountingConsumerAppModule, { logger: false });
  app.enableShutdownHooks(["SIGTERM", "SIGINT"]);
  app.get(AccountingConsumer).start();
  logger.info("accounting-consumer iniciado");
}

bootstrap().catch(exitOnBootstrapFailure("accounting-consumer"));

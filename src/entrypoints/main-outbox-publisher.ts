import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { OutboxPublisherAppModule } from "../app/outbox-publisher.module";
import { OutboxPublisher } from "../modules/wagering/infra/outbox/outbox-publisher";
import { exitOnBootstrapFailure } from "../shared/errors/bootstrap-failure";
import { logger } from "../shared/logger/logger";

/**
 * Processo `outbox-publisher` (D7.4, D9.6). `SIGTERM`/`SIGINT`: termina a
 * rodada atual e fecha; os leases dos outros vencem sozinhos (D8.6).
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(OutboxPublisherAppModule, { logger: false });
  app.enableShutdownHooks(["SIGTERM", "SIGINT"]);
  app.get(OutboxPublisher).start();
  logger.info("outbox-publisher iniciado");
}

bootstrap().catch(exitOnBootstrapFailure("outbox-publisher"));

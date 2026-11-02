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
  const publisher = app.get(OutboxPublisher);
  publisher.start();
  // O dono dos leases (D20.5): liga o `locked_by` da outbox a esta instância.
  logger.info({ leaseToken: publisher.leaseToken }, "outbox-publisher iniciado");
}

bootstrap().catch(exitOnBootstrapFailure("outbox-publisher"));

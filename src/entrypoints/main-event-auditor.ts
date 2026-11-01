import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { EventAuditorAppModule } from "../app/event-auditor.module";
import { EventAuditor } from "../modules/wagering/infra/messaging/event-auditor";
import { exitOnBootstrapFailure } from "../shared/errors/bootstrap-failure";
import { logger } from "../shared/logger/logger";

/**
 * Processo `event-auditor` (D7.4, D9.7). `SIGTERM`/`SIGINT`: o mesmo
 * `stop()` do consumidor (D8.5, D19.9, D20.2).
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(EventAuditorAppModule, { logger: false });
  app.enableShutdownHooks(["SIGTERM", "SIGINT"]);
  app.get(EventAuditor).start();
  logger.info("event-auditor iniciado");
}

bootstrap().catch(exitOnBootstrapFailure("event-auditor"));

import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { PendingWorkerAppModule } from "../app/pending-worker.module";
import { PendingWorker } from "../modules/wagering/infra/workers/pending-worker";
import { exitOnBootstrapFailure } from "../shared/errors/bootstrap-failure";
import { logger } from "../shared/logger/logger";

/**
 * Processo `pending-worker` (D4.3, D7.4). `SIGTERM`/`SIGINT`: termina o
 * item atual e fecha; os leases dos outros vencem sozinhos (D8.6, D18.8).
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(PendingWorkerAppModule, {
    logger: false,
  });
  app.enableShutdownHooks(["SIGTERM", "SIGINT"]);
  app.get(PendingWorker).start();
  logger.info("pending-worker iniciado");
}

bootstrap().catch(exitOnBootstrapFailure("pending-worker"));

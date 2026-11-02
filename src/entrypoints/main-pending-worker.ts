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
  const worker = app.get(PendingWorker);
  worker.start();
  // O dono dos leases (D18.10): liga o `locked_by` das pendentes a esta instância.
  logger.info({ leaseToken: worker.leaseToken }, "pending-worker iniciado");
}

bootstrap().catch(exitOnBootstrapFailure("pending-worker"));

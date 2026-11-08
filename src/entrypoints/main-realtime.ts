import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { RealtimeAppModule } from "../app/realtime.module";
import { configureRealtimeApp } from "../app/configure-realtime-app";
import { REALTIME_CONFIG, type RealtimeConfig } from "../modules/realtime/infra/realtime-config";
import { exitOnBootstrapFailure } from "../shared/errors/bootstrap-failure";
import { logger } from "../shared/logger/logger";

/**
 * Processo `realtime` (D28.11). A fila e a assinatura são garantidas antes
 * do `listen` (D28.5): só então a porta abre e o log `realtime iniciado`
 * sai. `SIGTERM`/`SIGINT`: sockets com `1001`, assinatura cancelada, laço
 * parado.
 */
async function bootstrap() {
  const app = await NestFactory.create(RealtimeAppModule, { logger: false });
  configureRealtimeApp(app);
  app.enableShutdownHooks(["SIGTERM", "SIGINT"]);
  const config = app.get<RealtimeConfig>(REALTIME_CONFIG);
  await app.listen(config.port, "0.0.0.0");
  logger.info({ instanceId: config.instanceId, port: config.port }, "realtime iniciado");
}

bootstrap().catch(exitOnBootstrapFailure("realtime"));

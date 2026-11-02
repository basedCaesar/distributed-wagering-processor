import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ApiModule } from "../app/api.module";
import { configureApiApp } from "../app/configure-api-app";
import { loadConfig } from "../shared/config/config";
import { exitOnBootstrapFailure } from "../shared/errors/bootstrap-failure";
import { logger } from "../shared/logger/logger";

/**
 * Processo `api` (D7.4). `SIGTERM`/`SIGINT`: readiness falsa, para de
 * aceitar, termina as requisições em andamento em até 10 s e só então
 * fecha o banco (D8.6, `ApiShutdown`). O Compose dá 30 s para parar.
 */
async function bootstrap() {
  const app = await NestFactory.create(ApiModule, { logger: false });
  app.enableShutdownHooks(["SIGTERM", "SIGINT"]);
  configureApiApp(app);
  const config = loadConfig();
  await app.listen(config.port);
  logger.info({ port: config.port }, "api iniciada");
}

bootstrap().catch(exitOnBootstrapFailure("api"));

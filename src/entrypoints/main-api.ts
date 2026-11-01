import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ApiModule } from "../app/api.module";
import { configureApiApp } from "../app/configure-api-app";
import { loadConfig } from "../shared/config/config";
import { exitOnBootstrapFailure } from "../shared/errors/bootstrap-failure";
import { logger } from "../shared/logger/logger";

async function bootstrap() {
  const app = await NestFactory.create(ApiModule, { logger: false });
  configureApiApp(app);
  const config = loadConfig();
  await app.listen(config.port);
  logger.info({ port: config.port }, "api iniciada");
}

bootstrap().catch(exitOnBootstrapFailure("api"));

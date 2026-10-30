import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ApiModule } from "../app/api.module";
import { loadConfig } from "../shared/config/config";
import { logger } from "../shared/logger/logger";

async function bootstrap() {
  const app = await NestFactory.create(ApiModule, { logger: false });
  const config = loadConfig();
  await app.listen(config.port);
  logger.info({ port: config.port }, "api iniciada");
}

bootstrap();

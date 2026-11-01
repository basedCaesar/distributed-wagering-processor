import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ConsumerAppModule } from "../app/consumer.module";
import { WagerTransactionsConsumer } from "../modules/wagering/infra/messaging/wager-transactions-consumer";
import { exitOnBootstrapFailure } from "../shared/errors/bootstrap-failure";
import { logger } from "../shared/logger/logger";

/**
 * Processo `consumer` (D7.4, D8). `SIGTERM`/`SIGINT`: para de buscar,
 * termina as mensagens em andamento em até 20 s e devolve as não
 * iniciadas (D8.5). O Compose dá 30 s para o processo parar.
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(ConsumerAppModule, { logger: false });
  app.enableShutdownHooks(["SIGTERM", "SIGINT"]);
  app.get(WagerTransactionsConsumer).start();
  logger.info("consumer iniciado");
}

bootstrap().catch(exitOnBootstrapFailure("consumer"));

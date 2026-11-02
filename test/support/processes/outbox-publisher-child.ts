import "reflect-metadata";
import { writeSync } from "node:fs";
import type { PublishCommand } from "@aws-sdk/client-sns";
import { MikroORM } from "@mikro-orm/postgresql";
import { Test } from "@nestjs/testing";
import type { Logger } from "pino";
import { OutboxPublisherAppModule } from "../../../src/app/outbox-publisher.module";
import { OutboxPublisher } from "../../../src/modules/wagering/infra/outbox/outbox-publisher";
import { SnsEventPublisher, type SnsSender } from "../../../src/modules/wagering/infra/outbox/sns-event-publisher";
import { MikroOrmOutboxStore } from "../../../src/modules/wagering/infra/persistence/outbox-store";
import { createSnsClient, topicArnOf } from "../../../src/shared/aws/sns-client";
import { APP_CONFIG, type AppConfig } from "../../../src/shared/config/config.module";
import { exitOnBootstrapFailure } from "../../../src/shared/errors/bootstrap-failure";
import { LOGGER } from "../../../src/shared/logger/logger.module";
import { logger } from "../../../src/shared/logger/logger";
// Nunca importe este arquivo de um teste: o import roda o bootstrap (o prefixo mora em processes.ts).
import { PUBLISH_PREFIX } from "../processes";

/**
 * Entrypoint de teste do R-13-C6 com processos separados (D21.4): o
 * `OutboxPublisherAppModule` real, com o cliente SNS decorado para contar
 * cada `Publish` numa linha `PUBLISH {"eventId": …}` no stdout. O resto é
 * o `main-outbox-publisher.ts`: mesma config, mesmo ORM, mesmo shutdown.
 */
function counting(client: SnsSender): SnsSender {
  return {
    send(command: PublishCommand) {
      // Síncrono: o teste mata o processo à força, e um write bufferizado se perderia.
      writeSync(1, `${PUBLISH_PREFIX}${JSON.stringify({ eventId: command.input.MessageDeduplicationId })}\n`);
      return client.send(command);
    },
  };
}

async function bootstrap() {
  const moduleRef = await Test.createTestingModule({ imports: [OutboxPublisherAppModule] })
    .overrideProvider(OutboxPublisher)
    .useFactory({
      factory: async (config: AppConfig, orm: MikroORM, log: Logger) => {
        const client = createSnsClient(config.aws, { requestTimeoutMs: config.outbox.snsRequestTimeoutMs });
        const topicArn = await topicArnOf(client, config.aws.sns.wageringEventsTopic);
        return new OutboxPublisher(
          new MikroOrmOutboxStore(orm),
          new SnsEventPublisher(counting(client), topicArn),
          log,
          { countStalled: () => undefined },
          { leaseMs: config.outbox.leaseMs },
        );
      },
      inject: [APP_CONFIG, MikroORM, LOGGER],
    })
    .compile();
  moduleRef.enableShutdownHooks(["SIGTERM", "SIGINT"]);
  await moduleRef.init();
  moduleRef.get(OutboxPublisher).start();
  logger.info("outbox-publisher iniciado");
}

bootstrap().catch(exitOnBootstrapFailure("outbox-publisher-child"));

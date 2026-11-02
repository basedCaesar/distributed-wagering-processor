import "reflect-metadata";
import { writeSync } from "node:fs";
import type { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { Test } from "@nestjs/testing";
import { OutboxPublisherAppModule } from "../../../src/app/outbox-publisher.module";
import { OutboxPublisher } from "../../../src/modules/wagering/infra/outbox/outbox-publisher";
import { SNS_CLIENT, SNS_SENDER } from "../../../src/modules/wagering/infra/outbox/outbox-publisher.module";
import type { SnsSender } from "../../../src/modules/wagering/infra/outbox/sns-event-publisher";
import { exitOnBootstrapFailure } from "../../../src/shared/errors/bootstrap-failure";
import { logger } from "../../../src/shared/logger/logger";
// Nunca importe este arquivo de um teste: o import roda o bootstrap (o prefixo mora em processes.ts).
import { PUBLISH_PREFIX } from "../processes";

/**
 * Entrypoint de teste do R-13-C6 com processos separados (D21.4): o
 * `OutboxPublisherAppModule` de produção inteiro (config, ORM, cliente SNS,
 * `OutboxPublisher`, shutdown). Só o provider `SNS_SENDER` é trocado, por um
 * decorador do próprio `SNS_CLIENT` que conta cada `Publish` numa linha
 * `PUBLISH {"eventId": …}` no stdout. Nada é montado à mão (achado 10 da
 * revisão da S8).
 */
function counting(client: SNSClient): SnsSender {
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
    .overrideProvider(SNS_SENDER)
    .useFactory({ factory: (client: SNSClient) => counting(client), inject: [SNS_CLIENT] })
    .compile();
  moduleRef.enableShutdownHooks(["SIGTERM", "SIGINT"]);
  await moduleRef.init();
  const publisher = moduleRef.get(OutboxPublisher);
  publisher.start();
  logger.info({ leaseToken: publisher.leaseToken }, "outbox-publisher iniciado");
}

bootstrap().catch(exitOnBootstrapFailure("outbox-publisher-child"));

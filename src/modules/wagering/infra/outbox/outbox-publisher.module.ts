import { Inject, Module, type OnModuleDestroy } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import type { Logger } from "pino";
import { createSnsClient, topicArnOf } from "../../../../shared/aws/sns-client";
import { APP_CONFIG, type AppConfig } from "../../../../shared/config/config.module";
import { LOGGER } from "../../../../shared/logger/logger.module";
import { outboxEventsStalledTotal } from "../../../../shared/metrics/metrics";
import { MikroOrmOutboxStore } from "../persistence/outbox-store";
import { OutboxPublisher } from "./outbox-publisher";
import { SnsEventPublisher } from "./sns-event-publisher";

/** Para o publisher antes de o ORM fechar (D8.6). */
class OutboxPublisherShutdown implements OnModuleDestroy {
  constructor(@Inject(OutboxPublisher) private readonly publisher: OutboxPublisher) {}

  async onModuleDestroy(): Promise<void> {
    await this.publisher.stop();
  }
}

/**
 * Contexto `wagering` no processo `outbox-publisher` (D7.4, D9.6). O
 * cliente SNS tem o timeout menor que o lease, validado na config (D20.5);
 * o ARN do tópico é resolvido pelo nome na subida (D20.9).
 */
@Module({
  providers: [
    {
      provide: OutboxPublisher,
      useFactory: async (config: AppConfig, orm: MikroORM, logger: Logger) => {
        const client = createSnsClient(config.aws, { requestTimeoutMs: config.outbox.snsRequestTimeoutMs });
        const topicArn = await topicArnOf(client, config.aws.sns.wageringEventsTopic);
        return new OutboxPublisher(
          new MikroOrmOutboxStore(orm),
          new SnsEventPublisher(client, topicArn),
          logger,
          { countStalled: () => outboxEventsStalledTotal.inc() },
          { leaseMs: config.outbox.leaseMs },
        );
      },
      inject: [APP_CONFIG, MikroORM, LOGGER],
    },
    OutboxPublisherShutdown,
  ],
  exports: [OutboxPublisher],
})
export class OutboxPublisherModule {}

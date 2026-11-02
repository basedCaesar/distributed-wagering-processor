import type { SNSClient } from "@aws-sdk/client-sns";
import { Inject, Module, type OnModuleDestroy } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import type { Logger } from "pino";
import { createSnsClient, topicArnOf } from "../../../../shared/aws/sns-client";
import { APP_CONFIG, type AppConfig } from "../../../../shared/config/config.module";
import { LOGGER } from "../../../../shared/logger/logger.module";
import { outboxEventsStalledTotal } from "../../../../shared/metrics/metrics";
import { trackOutboxBacklog } from "../observability/gauges";
import { MikroOrmOutboxStore } from "../persistence/outbox-store";
import { OutboxPublisher } from "./outbox-publisher";
import { SnsEventPublisher, type SnsSender } from "./sns-event-publisher";

/** A outbox vista pelo publisher: o claim e os gauges de atraso (D22.6). */
const OUTBOX_STORE = Symbol("OUTBOX_STORE");
/** Desfaz o registro dos gauges da outbox no shutdown. */
const OUTBOX_BACKLOG_TRACKING = Symbol("OUTBOX_BACKLOG_TRACKING");

/** Para o publisher antes de o ORM fechar (D8.6) e tira os gauges da outbox. */
class OutboxPublisherShutdown implements OnModuleDestroy {
  constructor(
    @Inject(OutboxPublisher) private readonly publisher: OutboxPublisher,
    @Inject(OUTBOX_BACKLOG_TRACKING) private readonly untrack: () => void,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.publisher.stop();
    this.untrack();
  }
}

/** O `SNSClient` do processo: timeout menor que o lease (D20.5). */
export const SNS_CLIENT = Symbol("SNS_CLIENT");
/**
 * Quem o publisher usa para o `Publish`. Por padrão, o próprio
 * `SNS_CLIENT`; o teste de processos separados (D21.4) troca só este
 * provider por um decorador que conta, e o resto da montagem é a de produção.
 */
export const SNS_SENDER = Symbol("SNS_SENDER");

/**
 * Contexto `wagering` no processo `outbox-publisher` (D7.4, D9.6). O
 * cliente SNS tem o timeout menor que o lease, validado na config (D20.5);
 * o ARN do tópico é resolvido pelo nome na subida (D20.9). Os gauges de
 * pendentes e lag são lidos no scrape (D22.6).
 */
@Module({
  providers: [
    {
      provide: SNS_CLIENT,
      useFactory: (config: AppConfig): SNSClient =>
        createSnsClient(config.aws, { requestTimeoutMs: config.outbox.snsRequestTimeoutMs }),
      inject: [APP_CONFIG],
    },
    { provide: SNS_SENDER, useExisting: SNS_CLIENT },
    {
      provide: OUTBOX_STORE,
      useFactory: (orm: MikroORM) => new MikroOrmOutboxStore(orm),
      inject: [MikroORM],
    },
    {
      provide: OUTBOX_BACKLOG_TRACKING,
      useFactory: (store: MikroOrmOutboxStore, logger: Logger, config: AppConfig) =>
        trackOutboxBacklog(store, logger, config.healthCheckTimeoutMs),
      inject: [OUTBOX_STORE, LOGGER, APP_CONFIG],
    },
    {
      provide: OutboxPublisher,
      useFactory: async (
        config: AppConfig,
        store: MikroOrmOutboxStore,
        logger: Logger,
        client: SNSClient,
        sender: SnsSender,
      ) => {
        const topicArn = await topicArnOf(client, config.aws.sns.wageringEventsTopic);
        return new OutboxPublisher(
          store,
          new SnsEventPublisher(sender, topicArn),
          logger,
          { countStalled: () => outboxEventsStalledTotal.inc() },
          { leaseMs: config.outbox.leaseMs },
        );
      },
      inject: [APP_CONFIG, OUTBOX_STORE, LOGGER, SNS_CLIENT, SNS_SENDER],
    },
    OutboxPublisherShutdown,
  ],
  exports: [OutboxPublisher],
})
export class OutboxPublisherModule {}

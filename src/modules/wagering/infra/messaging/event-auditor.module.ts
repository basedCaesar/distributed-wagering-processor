import { Inject, Module, type OnModuleDestroy } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import type { Logger } from "pino";
import { createSqsClient, queueUrlOf } from "../../../../shared/aws/sqs-client";
import { APP_CONFIG, type AppConfig } from "../../../../shared/config/config.module";
import { LOGGER } from "../../../../shared/logger/logger.module";
import { auditedEventsOutOfOrderTotal } from "../../../../shared/metrics/metrics";
import { AuditIntegrationEventUseCase } from "../../application/audit-integration-event.use-case";
import { UNIT_OF_WORK, type UnitOfWork } from "../../application/ports";
import { trackDlqDepth } from "../observability/gauges";
import { MikroOrmMessageAttempts } from "../persistence/message-attempts";
import { WageringCoreModule } from "../wagering-core.module";
import { EventAuditor } from "./event-auditor";
import { SqsWagerQueue } from "./sqs-wager-queue";

/** A fila assinante do auditor e a DLQ dela (D20.2). */
const AUDITOR_QUEUE = Symbol("AUDITOR_QUEUE");
/** Desfaz o registro do `sqs_dlq_depth` no shutdown. */
const DLQ_DEPTH_TRACKING = Symbol("AUDITOR_DLQ_DEPTH_TRACKING");

/** Para o auditor antes de o ORM fechar (D8.5, D20.2) e tira o gauge da DLQ. */
class EventAuditorShutdown implements OnModuleDestroy {
  constructor(
    @Inject(EventAuditor) private readonly auditor: EventAuditor,
    @Inject(DLQ_DEPTH_TRACKING) private readonly untrack: () => void,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.auditor.stop();
    this.untrack();
  }
}

/** Contexto `wagering` no processo `event-auditor` (D7.4, D9.7, D20). */
@Module({
  imports: [WageringCoreModule],
  providers: [
    {
      provide: AuditIntegrationEventUseCase,
      useFactory: (uow: UnitOfWork) => new AuditIntegrationEventUseCase(uow),
      inject: [UNIT_OF_WORK],
    },
    {
      provide: AUDITOR_QUEUE,
      useFactory: async (config: AppConfig) => {
        const client = createSqsClient(config.aws);
        return new SqsWagerQueue(client, {
          queueUrl: await queueUrlOf(client, config.aws.queues.wageringEventsAuditor),
          dlqUrl: await queueUrlOf(client, config.aws.queues.wageringEventsAuditorDlq),
        });
      },
      inject: [APP_CONFIG],
    },
    {
      provide: DLQ_DEPTH_TRACKING,
      useFactory: (queue: SqsWagerQueue, logger: Logger, config: AppConfig) =>
        trackDlqDepth("event_auditor_dlq", queue, logger, config.healthCheckTimeoutMs),
      inject: [AUDITOR_QUEUE, LOGGER, APP_CONFIG],
    },
    {
      provide: EventAuditor,
      useFactory: (orm: MikroORM, audit: AuditIntegrationEventUseCase, logger: Logger, queue: SqsWagerQueue) =>
        new EventAuditor({
          queue,
          attempts: new MikroOrmMessageAttempts(orm),
          logger,
          audit,
          alerts: { countOutOfOrder: () => auditedEventsOutOfOrderTotal.inc() },
        }),
      inject: [MikroORM, AuditIntegrationEventUseCase, LOGGER, AUDITOR_QUEUE],
    },
    EventAuditorShutdown,
  ],
  exports: [EventAuditor],
})
export class EventAuditorModule {}

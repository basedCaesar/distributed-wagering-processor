import { Inject, Module, type OnModuleDestroy } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import type { Logger } from "pino";
import { createSqsClient, queueUrlOf } from "../../../../shared/aws/sqs-client";
import { APP_CONFIG, type AppConfig } from "../../../../shared/config/config.module";
import { LOGGER } from "../../../../shared/logger/logger.module";
import { auditedEventsOutOfOrderTotal } from "../../../../shared/metrics/metrics";
import { AuditIntegrationEventUseCase } from "../../application/audit-integration-event.use-case";
import { UNIT_OF_WORK, type UnitOfWork } from "../../application/ports";
import { MikroOrmMessageAttempts } from "../persistence/message-attempts";
import { WageringCoreModule } from "../wagering-core.module";
import { EventAuditor } from "./event-auditor";
import { SqsWagerQueue } from "./sqs-wager-queue";

/** Para o auditor antes de o ORM fechar (D8.5, D20.2). */
class EventAuditorShutdown implements OnModuleDestroy {
  constructor(@Inject(EventAuditor) private readonly auditor: EventAuditor) {}

  async onModuleDestroy(): Promise<void> {
    await this.auditor.stop();
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
      provide: EventAuditor,
      useFactory: async (
        config: AppConfig,
        orm: MikroORM,
        audit: AuditIntegrationEventUseCase,
        logger: Logger,
      ) => {
        const client = createSqsClient(config.aws);
        const queue = new SqsWagerQueue(client, {
          queueUrl: await queueUrlOf(client, config.aws.queues.wageringEventsAuditor),
          dlqUrl: await queueUrlOf(client, config.aws.queues.wageringEventsAuditorDlq),
        });
        return new EventAuditor({
          queue,
          attempts: new MikroOrmMessageAttempts(orm),
          logger,
          audit,
          alerts: { countOutOfOrder: () => auditedEventsOutOfOrderTotal.inc() },
        });
      },
      inject: [APP_CONFIG, MikroORM, AuditIntegrationEventUseCase, LOGGER],
    },
    EventAuditorShutdown,
  ],
  exports: [EventAuditor],
})
export class EventAuditorModule {}

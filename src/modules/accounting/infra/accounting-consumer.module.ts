import { Inject, Module, type OnModuleDestroy } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import type { Logger } from "pino";
import { createSqsClient, queueUrlOf } from "../../../shared/aws/sqs-client";
import { APP_CONFIG, type AppConfig } from "../../../shared/config/config.module";
import { LOGGER } from "../../../shared/logger/logger.module";
import { accountingEntriesPostedTotal } from "../../../shared/metrics/metrics";
import { trackDlqDepth } from "../../wagering/infra/observability/gauges";
import { SqsWagerQueue } from "../../wagering/infra/messaging/sqs-wager-queue";
import { RecordEventHalfUseCase } from "../application/record-event-half.use-case";
import { loadAccountingConfig } from "./accounting-config";
import { AccountingConsumer } from "./messaging/accounting-consumer";
import { MikroOrmAccountingMessageAttempts } from "./persistence/accounting-message-attempts";
import { MikroOrmAccountingUnitOfWork } from "./persistence/accounting-unit-of-work";

/** A fila assinante do accounting e a DLQ dela (D27.5). */
const ACCOUNTING_QUEUE = Symbol("ACCOUNTING_QUEUE");
/** Desfaz o registro do `sqs_dlq_depth` no shutdown. */
const DLQ_DEPTH_TRACKING = Symbol("ACCOUNTING_DLQ_DEPTH_TRACKING");

/** Para o consumidor antes de o ORM fechar (D8.5) e tira o gauge da DLQ. */
class AccountingConsumerShutdown implements OnModuleDestroy {
  constructor(
    @Inject(AccountingConsumer) private readonly consumer: AccountingConsumer,
    @Inject(DLQ_DEPTH_TRACKING) private readonly untrack: () => void,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.consumer.stop();
    this.untrack();
  }
}

/** Contexto `accounting` no processo `accounting-consumer` (D27.6). */
@Module({
  providers: [
    {
      provide: RecordEventHalfUseCase,
      useFactory: (orm: MikroORM) =>
        new RecordEventHalfUseCase(new MikroOrmAccountingUnitOfWork(orm), { next: () => Bun.randomUUIDv7() }),
      inject: [MikroORM],
    },
    {
      provide: ACCOUNTING_QUEUE,
      useFactory: async (config: AppConfig) => {
        const accounting = loadAccountingConfig();
        const client = createSqsClient(config.aws);
        return new SqsWagerQueue(client, {
          queueUrl: await queueUrlOf(client, accounting.queues.accountingEvents),
          dlqUrl: await queueUrlOf(client, accounting.queues.accountingEventsDlq),
        });
      },
      inject: [APP_CONFIG],
    },
    {
      provide: DLQ_DEPTH_TRACKING,
      useFactory: (queue: SqsWagerQueue, logger: Logger, config: AppConfig) =>
        trackDlqDepth("accounting_dlq", queue, logger, config.healthCheckTimeoutMs),
      inject: [ACCOUNTING_QUEUE, LOGGER, APP_CONFIG],
    },
    {
      provide: AccountingConsumer,
      useFactory: (orm: MikroORM, record: RecordEventHalfUseCase, logger: Logger, queue: SqsWagerQueue) =>
        new AccountingConsumer({
          queue,
          attempts: new MikroOrmAccountingMessageAttempts(orm),
          logger,
          record,
          metrics: { countPosted: () => accountingEntriesPostedTotal.inc() },
        }),
      inject: [MikroORM, RecordEventHalfUseCase, LOGGER, ACCOUNTING_QUEUE],
    },
    AccountingConsumerShutdown,
  ],
  exports: [AccountingConsumer],
})
export class AccountingConsumerModule {}

import { Inject, Module, type OnModuleDestroy } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import type { Logger } from "pino";
import { createSqsClient, queueUrlOf } from "../../../../shared/aws/sqs-client";
import { APP_CONFIG, type AppConfig } from "../../../../shared/config/config.module";
import { LOGGER } from "../../../../shared/logger/logger.module";
import { wageringDuplicatesTotal } from "../../../../shared/metrics/metrics";
import { ID_GENERATOR, type IdGenerator, UNIT_OF_WORK, type UnitOfWork } from "../../application/ports";
import { SubmitWagerTransactionUseCase } from "../../application/submit-wager-transaction.use-case";
import { trackDlqDepth } from "../observability/gauges";
import { PromSubmissionMetrics } from "../observability/submission-metrics";
import { PromTransactionMetrics } from "../observability/transaction-metrics";
import { MikroOrmMessageAttempts } from "../persistence/message-attempts";
import { WageringCoreModule } from "../wagering-core.module";
import { SqsWagerQueue } from "./sqs-wager-queue";
import { WagerTransactionsConsumer } from "./wager-transactions-consumer";

/** A fila de transações e a DLQ dela (R-10-01): o consumidor e o gauge de profundidade (D22.4). */
const WAGER_QUEUE = Symbol("WAGER_QUEUE");
/** Desfaz o registro do `sqs_dlq_depth` no shutdown. */
const DLQ_DEPTH_TRACKING = Symbol("DLQ_DEPTH_TRACKING");

/** Para o consumidor antes de o ORM fechar (D8.5) e tira o gauge da DLQ. */
class ConsumerShutdown implements OnModuleDestroy {
  constructor(
    @Inject(WagerTransactionsConsumer) private readonly consumer: WagerTransactionsConsumer,
    @Inject(DLQ_DEPTH_TRACKING) private readonly untrack: () => void,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.consumer.stop();
    this.untrack();
  }
}

/** Contexto `wagering` no processo `consumer` (D7.4, D8). */
@Module({
  imports: [WageringCoreModule],
  providers: [
    {
      provide: SubmitWagerTransactionUseCase,
      useFactory: (uow: UnitOfWork, ids: IdGenerator, logger: Logger) =>
        new SubmitWagerTransactionUseCase(
          uow,
          ids,
          new PromSubmissionMetrics(wageringDuplicatesTotal),
          new PromTransactionMetrics(logger),
        ),
      inject: [UNIT_OF_WORK, ID_GENERATOR, LOGGER],
    },
    {
      provide: WAGER_QUEUE,
      useFactory: async (config: AppConfig) => {
        const client = createSqsClient(config.aws);
        return new SqsWagerQueue(client, {
          queueUrl: await queueUrlOf(client, config.aws.queues.wagerTransactions),
          dlqUrl: await queueUrlOf(client, config.aws.queues.wagerTransactionsDlq),
        });
      },
      inject: [APP_CONFIG],
    },
    {
      provide: DLQ_DEPTH_TRACKING,
      useFactory: (queue: SqsWagerQueue, logger: Logger, config: AppConfig) =>
        trackDlqDepth("wager_transactions_dlq", queue, logger, config.healthCheckTimeoutMs),
      inject: [WAGER_QUEUE, LOGGER, APP_CONFIG],
    },
    {
      provide: WagerTransactionsConsumer,
      useFactory: (
        config: AppConfig,
        orm: MikroORM,
        submit: SubmitWagerTransactionUseCase,
        logger: Logger,
        queue: SqsWagerQueue,
      ) =>
        new WagerTransactionsConsumer(
          {
            queue,
            submit,
            attempts: new MikroOrmMessageAttempts(orm),
            logger,
            currencies: config.currencies,
          },
          // Visibilidade e lote da config, validados juntos na subida (D19.6, D21.6).
          {
            visibilityTimeoutSeconds: config.consumer.visibilityTimeoutSeconds,
            maxMessages: config.consumer.maxMessages,
          },
        ),
      inject: [APP_CONFIG, MikroORM, SubmitWagerTransactionUseCase, LOGGER, WAGER_QUEUE],
    },
    ConsumerShutdown,
  ],
  exports: [WagerTransactionsConsumer],
})
export class ConsumerModule {}

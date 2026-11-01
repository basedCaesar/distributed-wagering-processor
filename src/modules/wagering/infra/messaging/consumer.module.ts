import { Inject, Module, type OnModuleDestroy } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import type { Logger } from "pino";
import { createSqsClient, queueUrlOf } from "../../../../shared/aws/sqs-client";
import { APP_CONFIG, type AppConfig } from "../../../../shared/config/config.module";
import { LOGGER } from "../../../../shared/logger/logger.module";
import { wageringDuplicatesTotal } from "../../../../shared/metrics/metrics";
import { ID_GENERATOR, type IdGenerator, UNIT_OF_WORK, type UnitOfWork } from "../../application/ports";
import { SubmitWagerTransactionUseCase } from "../../application/submit-wager-transaction.use-case";
import { PromSubmissionMetrics } from "../observability/submission-metrics";
import { MikroOrmMessageAttempts } from "../persistence/message-attempts";
import { WageringCoreModule } from "../wagering-core.module";
import { SqsWagerQueue } from "./sqs-wager-queue";
import { WagerTransactionsConsumer } from "./wager-transactions-consumer";

/** Para o consumidor antes de o ORM fechar (D8.5). */
class ConsumerShutdown implements OnModuleDestroy {
  constructor(@Inject(WagerTransactionsConsumer) private readonly consumer: WagerTransactionsConsumer) {}

  async onModuleDestroy(): Promise<void> {
    await this.consumer.stop();
  }
}

/** Contexto `wagering` no processo `consumer` (D7.4, D8). */
@Module({
  imports: [WageringCoreModule],
  providers: [
    {
      provide: SubmitWagerTransactionUseCase,
      useFactory: (uow: UnitOfWork, ids: IdGenerator) =>
        new SubmitWagerTransactionUseCase(uow, ids, new PromSubmissionMetrics(wageringDuplicatesTotal)),
      inject: [UNIT_OF_WORK, ID_GENERATOR],
    },
    {
      provide: WagerTransactionsConsumer,
      useFactory: async (
        config: AppConfig,
        orm: MikroORM,
        submit: SubmitWagerTransactionUseCase,
        logger: Logger,
      ) => {
        const client = createSqsClient(config.aws);
        const queue = new SqsWagerQueue(client, {
          queueUrl: await queueUrlOf(client, config.aws.queues.wagerTransactions),
          dlqUrl: await queueUrlOf(client, config.aws.queues.wagerTransactionsDlq),
        });
        return new WagerTransactionsConsumer({
          queue,
          submit,
          attempts: new MikroOrmMessageAttempts(orm),
          logger,
          currencies: config.currencies,
        });
      },
      inject: [APP_CONFIG, MikroORM, SubmitWagerTransactionUseCase, LOGGER],
    },
    ConsumerShutdown,
  ],
  exports: [WagerTransactionsConsumer],
})
export class ConsumerModule {}

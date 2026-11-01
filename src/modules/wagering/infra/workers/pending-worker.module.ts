import { Inject, Module, type OnModuleDestroy } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import type { Logger } from "pino";
import { LOGGER } from "../../../../shared/logger/logger.module";
import {
  CLOCK,
  type Clock,
  ID_GENERATOR,
  type IdGenerator,
  UNIT_OF_WORK,
  type UnitOfWork,
} from "../../application/ports";
import { ResolvePendingTransactionUseCase } from "../../application/resolve-pending-transaction.use-case";
import { MikroOrmPendingQueue } from "../persistence/pending-queue";
import { WageringCoreModule } from "../wagering-core.module";
import { PendingWorker } from "./pending-worker";

/** Para o laço antes de o ORM fechar (D18.8). */
class PendingWorkerShutdown implements OnModuleDestroy {
  constructor(@Inject(PendingWorker) private readonly worker: PendingWorker) {}

  async onModuleDestroy(): Promise<void> {
    await this.worker.stop();
  }
}

/** Contexto `wagering` no processo `pending-worker` (D4.3, D7.4). */
@Module({
  imports: [WageringCoreModule],
  providers: [
    {
      provide: ResolvePendingTransactionUseCase,
      useFactory: (uow: UnitOfWork, ids: IdGenerator, clock: Clock) =>
        new ResolvePendingTransactionUseCase(uow, ids, clock),
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK],
    },
    {
      provide: PendingWorker,
      useFactory: (orm: MikroORM, useCase: ResolvePendingTransactionUseCase, logger: Logger) =>
        new PendingWorker(new MikroOrmPendingQueue(orm), useCase, logger),
      inject: [MikroORM, ResolvePendingTransactionUseCase, LOGGER],
    },
    PendingWorkerShutdown,
  ],
  exports: [PendingWorker],
})
export class PendingWorkerModule {}

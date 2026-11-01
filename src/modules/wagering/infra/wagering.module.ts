import { Module } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import type { Logger } from "pino";
import { LOGGER } from "../../../shared/logger/logger.module";
import { reconciliationDivergencesTotal } from "../../../shared/metrics/metrics";
import { OpenWalletUseCase } from "../application/open-wallet.use-case";
import {
  CLOCK,
  type Clock,
  ID_GENERATOR,
  type IdGenerator,
  RECONCILIATION_LOG,
  RECONCILIATION_METRICS,
  type ReconciliationLog,
  type ReconciliationMetrics,
  UNIT_OF_WORK,
  type UnitOfWork,
} from "../application/ports";
import { ReconcileWalletUseCase } from "../application/reconcile-wallet.use-case";
import { SubmitWagerTransactionUseCase } from "../application/submit-wager-transaction.use-case";
import { TransactionQueries } from "../application/transaction-queries";
import { WalletQueries } from "../application/wallet-queries";
import { WagerTransactionsController } from "./http/wager-transactions.controller";
import { WalletsController } from "./http/wallets.controller";
import {
  PinoReconciliationLog,
  PromReconciliationMetrics,
} from "./observability/reconciliation-reporting";
import { MikroOrmUnitOfWork } from "./persistence/mikro-orm-unit-of-work";

/**
 * Contexto `wagering` no processo `api`. Os use cases são classes puras da
 * `application/`; aqui só se escolhem os adaptadores.
 */
@Module({
  controllers: [WalletsController, WagerTransactionsController],
  providers: [
    {
      provide: UNIT_OF_WORK,
      useFactory: (orm: MikroORM) => new MikroOrmUnitOfWork(orm),
      inject: [MikroORM],
    },
    {
      provide: ID_GENERATOR,
      useValue: { next: () => Bun.randomUUIDv7() } satisfies IdGenerator,
    },
    { provide: CLOCK, useValue: { now: () => new Date() } satisfies Clock },
    {
      provide: RECONCILIATION_METRICS,
      useValue: new PromReconciliationMetrics(reconciliationDivergencesTotal),
    },
    {
      provide: RECONCILIATION_LOG,
      useFactory: (logger: Logger) => new PinoReconciliationLog(logger),
      inject: [LOGGER],
    },
    {
      provide: OpenWalletUseCase,
      useFactory: (uow: UnitOfWork, ids: IdGenerator, clock: Clock) =>
        new OpenWalletUseCase(uow, ids, clock),
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK],
    },
    {
      provide: WalletQueries,
      useFactory: (uow: UnitOfWork) => new WalletQueries(uow),
      inject: [UNIT_OF_WORK],
    },
    {
      provide: SubmitWagerTransactionUseCase,
      useFactory: (uow: UnitOfWork, ids: IdGenerator, clock: Clock) =>
        new SubmitWagerTransactionUseCase(uow, ids, clock),
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK],
    },
    {
      provide: TransactionQueries,
      useFactory: (uow: UnitOfWork) => new TransactionQueries(uow),
      inject: [UNIT_OF_WORK],
    },
    {
      provide: ReconcileWalletUseCase,
      useFactory: (
        uow: UnitOfWork,
        ids: IdGenerator,
        clock: Clock,
        metrics: ReconciliationMetrics,
        log: ReconciliationLog,
      ) => new ReconcileWalletUseCase(uow, ids, clock, metrics, log),
      inject: [
        UNIT_OF_WORK,
        ID_GENERATOR,
        CLOCK,
        RECONCILIATION_METRICS,
        RECONCILIATION_LOG,
      ],
    },
  ],
})
export class WageringModule {}

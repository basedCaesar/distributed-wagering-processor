import { Module } from "@nestjs/common";
import type { Logger } from "pino";
import { LOGGER } from "../../../shared/logger/logger.module";
import {
  reconciliationDivergencesTotal,
  wageringDuplicatesTotal,
} from "../../../shared/metrics/metrics";
import { OpenWalletUseCase } from "../application/open-wallet.use-case";
import {
  ID_GENERATOR,
  type IdGenerator,
  RECONCILIATION_LOG,
  RECONCILIATION_METRICS,
  type ReconciliationLog,
  type ReconciliationMetrics,
  SUBMISSION_METRICS,
  type SubmissionMetrics,
  TRANSACTION_METRICS,
  type TransactionMetrics,
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
import { PromSubmissionMetrics } from "./observability/submission-metrics";
import { PromTransactionMetrics } from "./observability/transaction-metrics";
import { WageringCoreModule } from "./wagering-core.module";

/**
 * Contexto `wagering` no processo `api`. Os use cases são classes puras da
 * `application/`; aqui só se escolhem os adaptadores.
 */
@Module({
  imports: [WageringCoreModule],
  controllers: [WalletsController, WagerTransactionsController],
  providers: [
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
      provide: TRANSACTION_METRICS,
      useFactory: (logger: Logger) => new PromTransactionMetrics(logger),
      inject: [LOGGER],
    },
    {
      provide: OpenWalletUseCase,
      useFactory: (uow: UnitOfWork, ids: IdGenerator, metrics: TransactionMetrics) =>
        new OpenWalletUseCase(uow, ids, metrics),
      inject: [UNIT_OF_WORK, ID_GENERATOR, TRANSACTION_METRICS],
    },
    {
      provide: WalletQueries,
      useFactory: (uow: UnitOfWork) => new WalletQueries(uow),
      inject: [UNIT_OF_WORK],
    },
    {
      provide: SUBMISSION_METRICS,
      useValue: new PromSubmissionMetrics(wageringDuplicatesTotal),
    },
    {
      provide: SubmitWagerTransactionUseCase,
      useFactory: (
        uow: UnitOfWork,
        ids: IdGenerator,
        metrics: SubmissionMetrics,
        transactionMetrics: TransactionMetrics,
      ) => new SubmitWagerTransactionUseCase(uow, ids, metrics, transactionMetrics),
      inject: [UNIT_OF_WORK, ID_GENERATOR, SUBMISSION_METRICS, TRANSACTION_METRICS],
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
        metrics: ReconciliationMetrics,
        log: ReconciliationLog,
      ) => new ReconcileWalletUseCase(uow, ids, metrics, log),
      inject: [
        UNIT_OF_WORK,
        ID_GENERATOR,
        RECONCILIATION_METRICS,
        RECONCILIATION_LOG,
      ],
    },
  ],
})
export class WageringModule {}

import {
  reconcileWallet,
  type WalletReconciliation,
} from "../domain/wallet-reconciliation";
import { WalletNotFoundError } from "./errors";
import type {
  IdGenerator,
  ReconciliationLog,
  ReconciliationMetrics,
  UnitOfWork,
} from "./ports";

/**
 * `POST /wallets/:id/reconciliation` (R-09-18, R-09-19, D6.9). Lê a wallet
 * e o ledger no mesmo snapshot (`REPEATABLE READ`, sem lock: não trava
 * escritas) e grava a execução, com o horário do `now()` da transação
 * (D18.12). Divergência vira log, métrica e `consistent: false`; **nada é
 * corrigido**.
 */
export class ReconcileWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly metrics: ReconciliationMetrics,
    private readonly log: ReconciliationLog,
  ) {}

  async execute(walletId: string): Promise<WalletReconciliation> {
    const report = await this.uow.run(
      async (tx) => {
        const wallet = await tx.wallets.findById(walletId);
        if (!wallet) throw new WalletNotFoundError();
        const result = reconcileWallet(wallet, await tx.ledger.listAll(walletId));
        tx.reconciliationRuns.insert({
          id: this.ids.next(),
          report: result,
          executedAt: await tx.now(),
        });
        return result;
      },
      { isolation: "REPEATABLE_READ" },
    );

    if (!report.consistent) {
      this.metrics.countDivergence();
      this.log.divergence({
        walletId: report.walletId,
        issues: report.issues.map((issue) => issue.code),
        checkedEntries: report.checkedEntries,
      });
    }
    return report;
  }
}

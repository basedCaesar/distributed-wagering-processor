import type { EventContext } from "../domain/events/event-context";
import { FailureCode } from "../domain/failure-code";
import { type WagerTransaction, WagerTransactionStatus } from "../domain/wager-transaction";
import {
  applyWagerTransaction,
  expirePendingReference,
} from "../domain/wager-transaction-rules";
import type { Wallet } from "../domain/wallet";
import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import { isExpired, nextAttemptAt, reachedErrorLimit } from "./pending-policy";
import {
  type ClaimedPending,
  type IdGenerator,
  type LockedPending,
  NO_TRANSACTION_METRICS,
  type PendingControl,
  type TransactionMetrics,
  type TransactionScope,
  type UnitOfWork,
} from "./ports";
import { settledReferenceOf } from "./refund-after-settlement";
import { eventsForTransition } from "./transaction-events";

/** O que contar depois do commit (D22.2, D22.8). */
interface Settled {
  tx: WagerTransaction;
  settledReferenceId: string | undefined;
}

export type PendingResolution =
  /**
   * A linha já não está pendente (outra instância resolveu) ou o lease é
   * de outro worker (D18.10): nada é gravado.
   */
  | { kind: "skipped" }
  | { kind: "rescheduled"; nextAttemptAt: Date }
  | {
      kind: "resolved";
      status:
        | WagerTransactionStatus.Processed
        | WagerTransactionStatus.Rejected
        | WagerTransactionStatus.Failed;
    };

/**
 * Uma tentativa do worker sobre uma `PENDING_REFERENCE` já pega pelo claim
 * (R-07-20, D4.3). Mesmo caminho da submissão: trava a wallet, depois a
 * linha (mesma wallet), relê e aplica as regras do domínio (D14.2). Tudo
 * numa transação SQL: estado, lançamento, saldo, outbox e cutucada (D4.4).
 *
 * - lease de outro worker → `skipped` (D18.10);
 * - wallet inexistente → `FAILED PROCESSING_FAILED` direto (D18.13);
 * - referência resolvida → `PROCESSED` ou `REJECTED`;
 * - ainda esperando, dentro do prazo → reagenda com backoff (D4.3);
 * - ainda esperando, prazo esgotado → `REJECTED REFERENCE_NOT_FOUND` (D18.5).
 *
 * O relógio é o `now()` da transação no banco (D18.12), o mesmo do claim.
 *
 * `recordError` é o caminho do erro (D4.2, D18.4, D18.11), numa transação
 * própria depois que a tentativa foi desfeita.
 *
 * Nunca publica: eventos viram linhas da outbox (D9).
 *
 * Depois do commit, um estado terminal conta com `channel=worker` (D22.2),
 * e um `REFUND` aplicado a uma `BET` liquidada dispara o
 * `refund_after_settlement` (D1.7, D22.8).
 */
export class ResolvePendingTransactionUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly metrics: TransactionMetrics = NO_TRANSACTION_METRICS,
  ) {}

  async attempt(claimed: ClaimedPending): Promise<PendingResolution> {
    const settled: Settled[] = [];
    const resolution = await this.attemptInTransaction(claimed, settled);
    this.report(settled);
    return resolution;
  }

  async recordError(claimed: ClaimedPending, error: { transient: boolean }): Promise<PendingResolution> {
    const settled: Settled[] = [];
    const resolution = await this.recordErrorInTransaction(claimed, error, settled);
    this.report(settled);
    return resolution;
  }

  /** Já commitado (D22.2, D22.8). */
  private report(settled: readonly Settled[]): void {
    for (const { tx, settledReferenceId } of settled) {
      this.metrics.countDecision({ status: tx.status, kind: tx.kind, channel: "worker" });
      if (settledReferenceId !== undefined) {
        this.metrics.refundAfterSettlement({
          channel: "worker",
          transactionId: tx.id,
          walletId: tx.walletId,
          referenceTransactionId: settledReferenceId,
        });
      }
    }
  }

  private attemptInTransaction(claimed: ClaimedPending, settled: Settled[]): Promise<PendingResolution> {
    const attemptId = this.ids.next();
    return this.uow.run(async (scope) => {
      const locked = await lockPending(scope, claimed);
      if (!locked) return { kind: "skipped" };
      const { wallet, pending } = locked;
      const tx = pending.transaction;
      const now = await scope.now();

      if (!wallet) {
        // A FK garante a wallet: sem ela, é dado corrompido e nenhuma
        // tentativa vai resolver (D18.13).
        const control = afterError(pending.control, false);
        return this.fail(scope, { pending, control, attemptId, now, settled });
      }

      const reference = await scope.transactions.findReference(
        tx.providerId as string,
        tx.referenceExternalTransactionId as string,
      );
      const outcome = applyWagerTransaction({
        wallet,
        transaction: tx,
        reference,
        entryId: this.ids.next(),
        at: now,
      });
      const control: PendingControl = {
        attempts: pending.control.attempts + 1,
        consecutiveErrors: 0,
      };

      if (outcome.status === WagerTransactionStatus.PendingReference) {
        if (!isExpired(tx.createdAt, now)) {
          // Continua pendente: sem evento (D4.6), só o reagendamento.
          return this.reschedule(scope, tx, control, now);
        }
        expirePendingReference(wallet, tx);
      }
      const entry =
        outcome.status === WagerTransactionStatus.Processed ? outcome.entry : undefined;
      const settledReferenceId = await settledReferenceOf(scope.transactions, tx, reference);
      return this.settle(scope, { wallet, pending, control, entry, attemptId, now, settled, settledReferenceId });
    });
  }

  /**
   * A tentativa falhou e foi desfeita. Transitório: só backoff. Outro erro:
   * conta; no 5º seguido, `FAILED` (D4.2, D18.4). Sem wallet, `FAILED` já
   * no primeiro (D18.13). Não expira: não deu para avaliar (D18.11).
   */
  private recordErrorInTransaction(
    claimed: ClaimedPending,
    error: { transient: boolean },
    settled: Settled[],
  ): Promise<PendingResolution> {
    const attemptId = this.ids.next();
    return this.uow.run(async (scope) => {
      const locked = await lockPending(scope, claimed);
      if (!locked) return { kind: "skipped" };
      const { wallet, pending } = locked;
      const now = await scope.now();

      if (!wallet) {
        const control = afterError(pending.control, false);
        return this.fail(scope, { pending, control, attemptId, now, settled });
      }
      const control = afterError(pending.control, error.transient);
      if (error.transient || !reachedErrorLimit(control.consecutiveErrors)) {
        return this.reschedule(scope, pending.transaction, control, now);
      }
      return this.fail(scope, { pending, control, attemptId, now, settled });
    });
  }

  private reschedule(
    scope: TransactionScope,
    tx: WagerTransaction,
    control: PendingControl,
    now: Date,
  ): PendingResolution {
    const next = nextAttemptAt({ attempts: control.attempts, createdAt: tx.createdAt, now });
    scope.transactions.reschedule(tx.id, { ...control, nextAttemptAt: next });
    return { kind: "rescheduled", nextAttemptAt: next };
  }

  /** `FAILED PROCESSING_FAILED` (D4.2, D18.4, D18.13). */
  private fail(
    scope: TransactionScope,
    input: { pending: LockedPending; control: PendingControl; attemptId: string; now: Date; settled: Settled[] },
  ): Promise<PendingResolution> {
    input.pending.transaction.fail(FailureCode.ProcessingFailed);
    return this.settle(scope, { ...input, wallet: undefined, entry: undefined, settledReferenceId: undefined });
  }

  /** A pendente chegou a um estado terminal: grava, emite e cutuca (D4.4, D18.6). */
  private async settle(
    scope: TransactionScope,
    input: {
      wallet: Wallet | undefined;
      pending: LockedPending;
      control: PendingControl;
      entry: WalletLedgerEntry | undefined;
      attemptId: string;
      now: Date;
      /** Recebe o que contar depois do commit (D22.2, D22.8). */
      settled: Settled[];
      settledReferenceId: string | undefined;
    },
  ): Promise<PendingResolution> {
    const { wallet, pending, control, entry, attemptId, now } = input;
    const tx = pending.transaction;
    input.settled.push({ tx, settledReferenceId: input.settledReferenceId });
    scope.transactions.resolve(tx, control, now);
    if (entry && wallet) {
      scope.wallets.update(wallet);
      scope.ledger.insert(entry);
    }
    // Correlação da submissão original; causação = esta tentativa (D9.5, D18.3).
    const context = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId: pending.correlationId ?? attemptId,
      causationId: attemptId,
      occurredAt: now,
    });
    scope.outbox.append(eventsForTransition({ transaction: tx, wallet, entry, context }), tx.walletId);
    await scope.transactions.nudgeDependents(tx);
    return {
      kind: "resolved",
      status: tx.status as
        | WagerTransactionStatus.Processed
        | WagerTransactionStatus.Rejected
        | WagerTransactionStatus.Failed,
    };
  }
}

/** Tentativas depois de um erro (D18.1, D18.4): o transitório não conta como erro. */
function afterError(control: PendingControl, transient: boolean): PendingControl {
  return {
    attempts: control.attempts + 1,
    consecutiveErrors: control.consecutiveErrors + (transient ? 0 : 1),
  };
}

/**
 * Ordem de locks (CLAUDE.md, D7.2): wallet, depois a linha da mesma
 * wallet. Relê sob o lock: se já não está pendente, outra instância
 * resolveu; se o lease é de outro worker (o meu venceu e alguém reclamou,
 * ou já terminou e soltou), não é mais meu (D18.10). Nos dois casos, não
 * há o que fazer. A wallet pode faltar (D18.13): quem chama decide.
 */
async function lockPending(
  scope: TransactionScope,
  claimed: ClaimedPending,
): Promise<{ wallet: Wallet | undefined; pending: LockedPending } | undefined> {
  const wallet = await scope.wallets.lockById(claimed.walletId);
  const pending = await scope.transactions.lockPending(claimed.id);
  if (pending?.transaction.status !== WagerTransactionStatus.PendingReference) {
    return undefined;
  }
  if (pending.lockedBy !== claimed.leaseToken) return undefined;
  return { wallet, pending };
}

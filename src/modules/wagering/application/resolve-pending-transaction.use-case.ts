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
import type {
  ClaimedPending,
  Clock,
  IdGenerator,
  LockedPending,
  PendingControl,
  TransactionScope,
  UnitOfWork,
} from "./ports";
import { eventsForTransition } from "./transaction-events";

export type PendingResolution =
  /** A linha já não está pendente (outra instância resolveu). */
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
 * - referência resolvida → `PROCESSED` ou `REJECTED`;
 * - ainda esperando, dentro do prazo → reagenda com backoff (D4.3);
 * - ainda esperando, prazo esgotado → `REJECTED REFERENCE_NOT_FOUND` (D18.5).
 *
 * `recordError` é o caminho do erro (D4.2, D18.4), numa transação própria
 * depois que a tentativa foi desfeita.
 *
 * Nunca publica: eventos viram linhas da outbox (D9).
 */
export class ResolvePendingTransactionUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  attempt(claimed: ClaimedPending): Promise<PendingResolution> {
    const attemptId = this.ids.next();
    return this.uow.run(async (scope) => {
      const locked = await lockPending(scope, claimed);
      if (!locked) return { kind: "skipped" };
      const { wallet, pending } = locked;
      const tx = pending.transaction;
      const now = this.clock.now();

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
      return this.settle(scope, { wallet, pending, control, entry, attemptId, now });
    });
  }

  /**
   * A tentativa falhou e foi desfeita. Transitório: só backoff. Outro erro:
   * conta; no 5º seguido, `FAILED` (D4.2, D18.4).
   */
  recordError(
    claimed: ClaimedPending,
    error: { transient: boolean },
  ): Promise<PendingResolution> {
    const attemptId = this.ids.next();
    return this.uow.run(async (scope) => {
      const locked = await lockPending(scope, claimed);
      if (!locked) return { kind: "skipped" };
      const { wallet, pending } = locked;
      const tx = pending.transaction;
      const now = this.clock.now();
      const control: PendingControl = {
        attempts: pending.control.attempts + 1,
        consecutiveErrors: pending.control.consecutiveErrors + (error.transient ? 0 : 1),
      };

      if (error.transient || !reachedErrorLimit(control.consecutiveErrors)) {
        return this.reschedule(scope, tx, control, now);
      }
      tx.fail(FailureCode.ProcessingFailed);
      return this.settle(scope, { wallet, pending, control, entry: undefined, attemptId, now });
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

  /** A pendente chegou a um estado terminal: grava, emite e cutuca (D4.4, D18.6). */
  private async settle(
    scope: TransactionScope,
    input: {
      wallet: Wallet;
      pending: LockedPending;
      control: PendingControl;
      entry: WalletLedgerEntry | undefined;
      attemptId: string;
      now: Date;
    },
  ): Promise<PendingResolution> {
    const { wallet, pending, control, entry, attemptId, now } = input;
    const tx = pending.transaction;
    scope.transactions.resolve(tx, control);
    if (entry) {
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
    scope.outbox.append(eventsForTransition({ transaction: tx, wallet, entry, context }), wallet.id);
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

/**
 * Ordem de locks (CLAUDE.md, D7.2): wallet, depois a linha da mesma
 * wallet. Relê sob o lock: se já não está pendente, outra instância
 * resolveu (lease vencido) e não há o que fazer.
 */
async function lockPending(
  scope: TransactionScope,
  claimed: ClaimedPending,
): Promise<{ wallet: Wallet; pending: LockedPending } | undefined> {
  const wallet = await scope.wallets.lockById(claimed.walletId);
  if (!wallet) {
    // A FK garante a wallet: sem ela, é dado corrompido (conta como erro).
    throw new Error(`wallet ${claimed.walletId} da pendente ${claimed.id} não existe`);
  }
  const pending = await scope.transactions.lockPending(claimed.id);
  if (pending?.transaction.status !== WagerTransactionStatus.PendingReference) {
    return undefined;
  }
  return { wallet, pending };
}

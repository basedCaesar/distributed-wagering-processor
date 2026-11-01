import type { EventContext } from "../domain/events/event-context";
import type { IntegrationEvent } from "../domain/events/integration-event";
import { WagerTransactionFailed } from "../domain/events/wager-transaction-failed";
import { WagerTransactionPendingReference } from "../domain/events/wager-transaction-pending-reference";
import { WagerTransactionProcessed } from "../domain/events/wager-transaction-processed";
import { WagerTransactionRejected } from "../domain/events/wager-transaction-rejected";
import { WalletBalanceChanged } from "../domain/events/wallet-balance-changed";
import { type WagerTransaction, WagerTransactionStatus } from "../domain/wager-transaction";
import type { Wallet } from "../domain/wallet";
import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry";

/**
 * Eventos de uma transação que acabou de mudar de estado (D9.4), na ordem
 * em que vão para a outbox. Mesmo caminho na submissão e no worker.
 * `PENDING_REFERENCE` só emite ao entrar no estado (D4.6): quem chama só
 * pede eventos numa transição.
 */
export function eventsForTransition(input: {
  transaction: WagerTransaction;
  wallet: Wallet;
  entry: WalletLedgerEntry | undefined;
  context: () => EventContext;
}): IntegrationEvent<unknown>[] {
  const { transaction, wallet, entry, context } = input;
  switch (transaction.status) {
    case WagerTransactionStatus.Processed:
      return entry
        ? [
            WagerTransactionProcessed.from(transaction, entry, context()),
            WalletBalanceChanged.from(wallet, entry, context()),
          ]
        : [WagerTransactionProcessed.from(transaction, undefined, context())];
    case WagerTransactionStatus.Rejected:
      return [WagerTransactionRejected.from(transaction, context())];
    case WagerTransactionStatus.PendingReference:
      return [WagerTransactionPendingReference.from(transaction, context())];
    case WagerTransactionStatus.Failed:
      return [WagerTransactionFailed.from(transaction, context())];
    case WagerTransactionStatus.Pending:
      throw new Error(`transação ${transaction.id} sem decisão não emite evento (D4.1)`);
  }
}

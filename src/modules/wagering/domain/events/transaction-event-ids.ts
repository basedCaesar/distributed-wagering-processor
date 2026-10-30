import { InvalidTransactionStateError } from "../domain-error";
import type {
  WagerTransaction,
  WagerTransactionStatus,
} from "../wager-transaction";

/**
 * Os "ids" dos eventos de transação (D9.4, D14.4). Nulos na `OPENING`.
 * Sem `playerId` (D11.1, D14.4).
 */
export interface TransactionEventIds {
  transactionId: string;
  walletId: string;
  providerId: string | null;
  externalTransactionId: string | null;
  roundId: string | null;
  gameId: string | null;
}

export function transactionEventIds(tx: WagerTransaction): TransactionEventIds {
  return {
    transactionId: tx.id,
    walletId: tx.walletId,
    providerId: tx.providerId ?? null,
    externalTransactionId: tx.externalTransactionId ?? null,
    roundId: tx.roundId ?? null,
    gameId: tx.gameId ?? null,
  };
}

/** Um evento de transação só nasce do estado que ele anuncia. */
export function assertStatus(
  tx: WagerTransaction,
  expected: WagerTransactionStatus,
  eventType: string,
): void {
  if (tx.status !== expected) {
    throw new InvalidTransactionStateError(
      `${eventType} exige ${expected}, mas a transação está ${tx.status}`,
    );
  }
}

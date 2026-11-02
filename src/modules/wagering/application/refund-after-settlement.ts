import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction";
import type { ReferenceLookup } from "../domain/wager-transaction-rules";
import type { WagerTransactionRepository } from "./ports";

/**
 * D1.7, D22.8: um `REFUND` **aplicado** (`PROCESSED`) cuja `BET` já tem um
 * `WIN` ou `LOSS` `PROCESSED`. É só observação: não muda a decisão. Chamado
 * sob o lock da wallet, depois das regras, e consulta o banco só nesse
 * caso. Devolve o id da `BET` liquidada, ou `undefined`.
 *
 * Limitação: um `WIN`/`LOSS` sem referência (D1.6) não marca a `BET` como
 * liquidada.
 */
export async function settledReferenceOf(
  transactions: Pick<WagerTransactionRepository, "isSettled">,
  transaction: WagerTransaction,
  reference: ReferenceLookup | undefined,
): Promise<string | undefined> {
  if (transaction.kind !== WagerTransactionKind.Refund) return undefined;
  if (transaction.status !== WagerTransactionStatus.Processed) return undefined;
  if (!reference?.found) return undefined;
  return (await transactions.isSettled(reference.transaction.id)) ? reference.transaction.id : undefined;
}

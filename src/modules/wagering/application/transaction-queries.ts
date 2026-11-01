import type { WagerTransaction } from "../domain/wager-transaction";
import { TransactionNotFoundError } from "./errors";
import type { UnitOfWork } from "./ports";

/**
 * Quem consulta (D10.2): o operador vê tudo; um provedor, só as próprias
 * transações. O que é de outro provedor responde `404`, como o inexistente.
 */
export type TransactionViewer =
  | { kind: "operator" }
  | { kind: "provider"; providerId: string };

/** `GET` de transação por id e por id externo (R-09-08, R-09-09). */
export class TransactionQueries {
  constructor(private readonly uow: UnitOfWork) {}

  async getById(id: string, viewer: TransactionViewer): Promise<WagerTransaction> {
    const transaction = await this.uow.run((tx) => tx.transactions.findById(id));
    return visibleOrNotFound(transaction, viewer);
  }

  async getByExternalId(
    providerId: string,
    externalTransactionId: string,
    viewer: TransactionViewer,
  ): Promise<WagerTransaction> {
    // `providerId` da rota diferente do token: nem consulta (D10.2).
    if (viewer.kind === "provider" && viewer.providerId !== providerId) {
      throw new TransactionNotFoundError();
    }
    const transaction = await this.uow.run((tx) =>
      tx.transactions.findByProviderAndExternalId(providerId, externalTransactionId),
    );
    return visibleOrNotFound(transaction, viewer);
  }
}

/** A `OPENING` não tem provedor, então só o operador a vê (D6.1). */
function visibleOrNotFound(
  transaction: WagerTransaction | undefined,
  viewer: TransactionViewer,
): WagerTransaction {
  if (
    !transaction ||
    (viewer.kind === "provider" && transaction.providerId !== viewer.providerId)
  ) {
    throw new TransactionNotFoundError();
  }
  return transaction;
}

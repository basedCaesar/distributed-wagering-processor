import { HttpStatus } from "@nestjs/common";
import type { SubmissionResult } from "../../application/submit-wager-transaction.use-case";
import { type WagerTransaction, WagerTransactionStatus } from "../../domain/wager-transaction";
import { FAILURE_CODE_HTTP_STATUS } from "./failure-code-http-status";

/**
 * Status do estado atual da transação (D5, D3.4): o replay usa o mesmo,
 * então um terminal responde sempre o da primeira vez.
 */
export function submissionHttpStatus(tx: WagerTransaction): HttpStatus {
  switch (tx.status) {
    case WagerTransactionStatus.Processed:
      return HttpStatus.OK;
    case WagerTransactionStatus.PendingReference:
      return HttpStatus.ACCEPTED;
    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed:
      if (tx.failureCode === undefined) {
        throw new Error(`transação ${tx.id} ${tx.status} sem failureCode`);
      }
      return FAILURE_CODE_HTTP_STATUS[tx.failureCode];
    case WagerTransactionStatus.Pending:
      throw new Error(`transação ${tx.id} PENDING não sai do use case (D4.1)`);
  }
}

/** `{ transactionId, status, failureCode?, failureDetail?, balance?, idempotentReplay }` (D5, D14.3). */
export function presentSubmission({ transaction: tx, idempotentReplay }: SubmissionResult) {
  return {
    transactionId: tx.id,
    status: tx.status,
    ...(tx.failureCode !== undefined && { failureCode: tx.failureCode }),
    ...(tx.failureDetail !== undefined && { failureDetail: tx.failureDetail }),
    ...(tx.balanceAfter !== undefined && { balance: tx.balanceAfter.toJSON() }),
    idempotentReplay,
  };
}

/** `GET` de transação (D5). Campos do provedor são `null` na `OPENING` (D6.1). */
export function presentTransaction(tx: WagerTransaction) {
  return {
    transactionId: tx.id,
    providerId: tx.providerId ?? null,
    externalTransactionId: tx.externalTransactionId ?? null,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId ?? null,
    gameId: tx.gameId ?? null,
    kind: tx.kind,
    money: tx.money.toJSON(),
    ...(tx.referenceExternalTransactionId !== undefined && {
      referenceExternalTransactionId: tx.referenceExternalTransactionId,
    }),
    ...(tx.referenceTransactionId !== undefined && {
      referenceTransactionId: tx.referenceTransactionId,
    }),
    status: tx.status,
    ...(tx.failureCode !== undefined && { failureCode: tx.failureCode }),
    ...(tx.failureDetail !== undefined && { failureDetail: tx.failureDetail }),
    ...(tx.balanceAfter !== undefined && { balance: tx.balanceAfter.toJSON() }),
    createdAt: tx.createdAt.toISOString(),
    ...(tx.processedAt !== undefined && { processedAt: tx.processedAt.toISOString() }),
  };
}

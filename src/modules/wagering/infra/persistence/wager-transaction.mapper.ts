import type {
  FailureCode,
  ReferenceScopeField,
} from "../../domain/failure-code";
import { Money } from "../../domain/money";
import {
  WagerTransaction,
  type WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wager-transaction";
import type { WagerTransactionRecord } from "./wager-transaction.schema";

export class UnpersistableTransactionError extends Error {
  constructor(id: string) {
    super(`transação ${id} ainda está PENDING: PENDING nunca é gravado (D4.1)`);
    this.name = "UnpersistableTransactionError";
  }
}

/** O que a linha tem e a entidade não: vem de quem grava (o repositório, S4). */
export interface WagerTransactionRowContext {
  updatedAt: Date;
  /** `correlationId` da submissão (D9.5); `null` se não houver. */
  correlationId: string | null;
}

/** `undefined` do domínio vira `null` na linha. */
export function wagerTransactionToRecord(
  tx: WagerTransaction,
  { updatedAt, correlationId }: WagerTransactionRowContext,
): WagerTransactionRecord {
  if (tx.status === WagerTransactionStatus.Pending) {
    throw new UnpersistableTransactionError(tx.id);
  }
  return {
    id: tx.id,
    providerId: tx.providerId ?? null,
    externalTransactionId: tx.externalTransactionId ?? null,
    idempotencyKey: tx.idempotencyKey ?? null,
    payloadHash: tx.payloadHash ?? null,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId ?? null,
    gameId: tx.gameId ?? null,
    kind: tx.kind,
    amount: tx.money.toString(),
    currency: tx.money.currency,
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    failureDetail: tx.failureDetail ?? null,
    balanceAfter: tx.balanceAfter?.toString() ?? null,
    balanceAfterCurrency: tx.balanceAfter?.currency ?? null,
    processedAt: tx.processedAt ?? null,
    createdAt: tx.createdAt,
    updatedAt,
    correlationId,
  };
}

export function wagerTransactionFromRecord(
  record: WagerTransactionRecord,
): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId ?? undefined,
    externalTransactionId: record.externalTransactionId ?? undefined,
    idempotencyKey: record.idempotencyKey ?? undefined,
    payloadHash: record.payloadHash ?? undefined,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId ?? undefined,
    gameId: record.gameId ?? undefined,
    kind: record.kind as WagerTransactionKind,
    money: Money.rehydrate({
      amount: record.amount,
      currency: record.currency,
    }),
    referenceExternalTransactionId:
      record.referenceExternalTransactionId ?? undefined,
    createdAt: record.createdAt,
    status: record.status as WagerTransactionStatus,
    referenceTransactionId: record.referenceTransactionId ?? undefined,
    failureCode: (record.failureCode ?? undefined) as FailureCode | undefined,
    failureDetail: (record.failureDetail ?? undefined) as
      | ReferenceScopeField
      | undefined,
    balanceAfter:
      record.balanceAfter !== null && record.balanceAfterCurrency !== null
        ? Money.rehydrate({
            amount: record.balanceAfter,
            currency: record.balanceAfterCurrency,
          })
        : undefined,
    processedAt: record.processedAt ?? undefined,
  });
}

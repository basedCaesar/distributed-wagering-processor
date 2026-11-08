import type { Amount } from "../domain/amount";
import type { JournalEntry, LineDirection } from "../domain/journal-entry";

interface EventHalfBase {
  eventId: string;
  transactionId: string;
  walletId: string;
  walletVersion: number;
  amount: Amount;
  balanceAfter: Amount;
  occurredAt: Date;
}

/** A metade do `WalletBalanceChanged` (D27.1): direção e saldos. */
export interface BalanceChangedHalf extends EventHalfBase {
  type: "WalletBalanceChanged";
  direction: LineDirection;
  balanceBefore: Amount;
}

/** A metade do `WagerTransactionProcessed` com `walletVersion` (D27.1): o `kind`. */
export interface TransactionProcessedHalf extends EventHalfBase {
  type: "WagerTransactionProcessed";
  kind: string;
}

export type EventHalf = BalanceChangedHalf | TransactionProcessedHalf;
export type EventHalfType = EventHalf["type"];

export type InboxRegistration = "new" | "duplicate" | "conflict";

/** O que o use case faz dentro de uma transação SQL só (D27.4). */
export interface AccountingScope {
  /** Lock 1: a chave da inbox, o primeiro comando da transação (D19.4). */
  registerInbox(entry: { consumerName: string; messageId: string; hash: string }): Promise<InboxRegistration>;
  /**
   * Lock 2: a conta `PLAYER_WALLET` da wallet, criada se faltar e travada
   * (`FOR UPDATE`). Devolve a moeda da conta, que pode ser outra.
   */
  lockPlayerAccount(walletId: string, currency: string): Promise<{ currency: string }>;
  findHalf(transactionId: string, type: EventHalfType): Promise<EventHalf | undefined>;
  insertHalf(half: EventHalf): Promise<void>;
  /** Grava o lançamento e as linhas (as contas da casa são criadas se faltarem). */
  postEntry(entry: JournalEntry, sources: { balanceEventId: string; processedEventId: string; occurredAt: Date }): Promise<void>;
}

export interface AccountingUnitOfWork {
  run<T>(work: (scope: AccountingScope) => Promise<T>): Promise<T>;
}

/** Ids gerados na aplicação (UUIDv7, como a D6.6). */
export interface AccountingIdGenerator {
  next(): string;
}

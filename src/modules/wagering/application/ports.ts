import type { IntegrationEvent } from "../domain/events/integration-event";
import type { WagerTransaction } from "../domain/wager-transaction";
import type { Wallet } from "../domain/wallet";
import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import type {
  ReconciliationIssueCode,
  WalletReconciliation,
} from "../domain/wallet-reconciliation";

/** UUIDv7 gerado na aplicação (D6.6). */
export interface IdGenerator {
  next(): string;
}

export interface Clock {
  now(): Date;
}

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  findIdByPlayerAndCurrency(
    playerId: string,
    currency: string,
  ): Promise<string | undefined>;
  /** Lança `DuplicateWalletError` se o par `(playerId, currency)` já existe. */
  insert(wallet: Wallet): Promise<void>;
}

export interface WagerTransactionRepository {
  /** `correlationId` da submissão vai para a linha, não para a entidade (D9.5). */
  insert(tx: WagerTransaction, correlationId: string): void;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): void;
  /** Lançamentos com versão > `afterVersion`, em ordem crescente (D6.8). */
  listPage(
    walletId: string,
    afterVersion: number,
    limit: number,
  ): Promise<WalletLedgerEntry[]>;
  /** Todos, em ordem crescente de versão (reconciliação, D6.9). */
  listAll(walletId: string): Promise<WalletLedgerEntry[]>;
}

/** Use cases nunca publicam: eventos viram linhas da outbox (D3, D9). */
export interface OutboxWriter {
  /** Na ordem dada; `orderingKey` = walletId (D9.2, D9.3). */
  append(events: readonly IntegrationEvent<unknown>[], orderingKey: string): void;
}

export interface ReconciliationRunRepository {
  insert(run: {
    id: string;
    report: WalletReconciliation;
    executedAt: Date;
  }): void;
}

/** Repositórios presos a uma transação SQL aberta pelo use case. */
export interface TransactionScope {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxWriter;
  reconciliationRuns: ReconciliationRunRepository;
}

export type IsolationLevel = "READ_COMMITTED" | "REPEATABLE_READ";

/**
 * Uma transação SQL por chamada (CLAUDE.md, D3/D4/D7): tudo o que `work`
 * grava é comprometido junto, ou nada.
 */
export interface UnitOfWork {
  run<T>(
    work: (scope: TransactionScope) => Promise<T>,
    options?: { isolation?: IsolationLevel },
  ): Promise<T>;
}

/** Contagem de divergências (R-09-19, D16.6). */
export interface ReconciliationMetrics {
  countDivergence(): void;
}

/** Log da divergência, sem valores nem saldos (R-09-19, D11.1). */
export interface ReconciliationLog {
  divergence(details: {
    walletId: string;
    issues: ReconciliationIssueCode[];
    checkedEntries: number;
  }): void;
}

/** Rastreio da operação, para os eventos (D9.5). */
export interface OperationMeta {
  correlationId: string;
  causationId: string;
}

export const UNIT_OF_WORK = Symbol("UNIT_OF_WORK");
export const ID_GENERATOR = Symbol("ID_GENERATOR");
export const CLOCK = Symbol("CLOCK");
export const RECONCILIATION_METRICS = Symbol("RECONCILIATION_METRICS");
export const RECONCILIATION_LOG = Symbol("RECONCILIATION_LOG");

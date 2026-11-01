import type { IntegrationEvent } from "../domain/events/integration-event";
import type { WagerTransaction } from "../domain/wager-transaction";
import type { ReferenceLookup } from "../domain/wager-transaction-rules";
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
  /**
   * `SELECT … FOR UPDATE` (D7.2): segura a wallet até o fim da transação.
   * Espera no máximo o `lock_timeout` (D5); estourou → erro transitório.
   */
  lockById(id: string): Promise<Wallet | undefined>;
  /** Grava saldo, `version` e `updatedAt` como o domínio deixou (D7.2). Só depois do `lockById`. */
  update(wallet: Wallet): void;
  findIdByPlayerAndCurrency(
    playerId: string,
    currency: string,
  ): Promise<string | undefined>;
  /** Lança `DuplicateWalletError` se o par `(playerId, currency)` já existe. */
  insert(wallet: Wallet): Promise<void>;
}

export interface WagerTransactionRepository {
  /**
   * `correlationId` da submissão vai para a linha, não para a entidade
   * (D9.5). Uma `PENDING_REFERENCE` nasce já vencida para o worker (D17.4).
   * Key ou id externo repetido → `DuplicateTransactionError` no commit (D3.6).
   */
  insert(tx: WagerTransaction, correlationId: string): void;
  findById(id: string): Promise<WagerTransaction | undefined>;
  /** Unicidade da D3.1. */
  findByProviderAndKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined>;
  /** Unicidade da D3.2. */
  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  /**
   * Referência por `(providerId, referenceExternalTransactionId)` (R-07-07).
   * `alreadyReversed` = existe `REFUND` ou `ROLLBACK` `PROCESSED` cujo
   * `reference_transaction_id` é ela; reversões `REJECTED` ou pendentes
   * não contam (D1.1, D1.3).
   */
  findReference(
    providerId: string,
    referenceExternalTransactionId: string,
  ): Promise<ReferenceLookup>;
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

/**
 * Onde a duplicata de uma key foi detectada (D11.2, D17.7):
 * - `fast_path`: checagem rápida, antes do lock (operação antiga);
 * - `lock`: checagem autoritativa, depois do lock da wallet (D3.6);
 * - `unique_index`: o `UNIQUE` de key ou de id externo barrou o commit
 *   (outra wallet, outro lock); a repetição que vem depois não conta de novo.
 */
export type DuplicateLayer = "fast_path" | "lock" | "unique_index";

/** Contagem de duplicatas por camada (D11.2, D17.7). */
export interface SubmissionMetrics {
  countDuplicate(layer: DuplicateLayer): void;
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
export const SUBMISSION_METRICS = Symbol("SUBMISSION_METRICS");

import {
  IsolationLevel,
  LockMode,
  UniqueConstraintViolationException,
  wrap,
} from "@mikro-orm/core";
import type { EntityManager, MikroORM } from "@mikro-orm/postgresql";
import type { IntegrationEvent } from "../../domain/events/integration-event";
import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wager-transaction";
import type { Wallet } from "../../domain/wallet";
import type { WalletLedgerEntry } from "../../domain/wallet-ledger-entry";
import type { WalletReconciliation } from "../../domain/wallet-reconciliation";
import {
  DuplicateTransactionError,
  DuplicateWalletError,
} from "../../application/errors";
import type {
  IsolationLevel as AppIsolationLevel,
  LedgerRepository,
  OutboxWriter,
  PendingControl,
  ReconciliationRunRepository,
  TransactionScope,
  UnitOfWork,
  WagerTransactionRepository,
  WalletRepository,
} from "../../application/ports";
import { OutboxMessageSchema } from "./outbox-message.schema";
import { ReconciliationRunSchema } from "./reconciliation-run.schema";
import {
  wagerTransactionFromRecord,
  wagerTransactionToRecord,
} from "./wager-transaction.mapper";
import {
  type WagerTransactionRecord,
  WagerTransactionSchema,
} from "./wager-transaction.schema";
import {
  ledgerEntryFromRecord,
  ledgerEntryToRecord,
} from "./wallet-ledger-entry.mapper";
import { WalletLedgerEntrySchema } from "./wallet-ledger-entry.schema";
import { walletFromRecord, walletToRecord } from "./wallet.mapper";
import { WalletSchema } from "./wallet.schema";

const WALLET_PLAYER_CURRENCY_UQ = "wallets_player_currency_uq";

/** Barreiras finais da idempotência (D3.1, D3.2, D3.6). */
const TRANSACTION_IDENTITY_UQS: ReadonlySet<string> = new Set([
  "wager_transactions_provider_key_uq",
  "wager_transactions_provider_external_uq",
]);

const REVERSAL_KINDS = [WagerTransactionKind.Refund, WagerTransactionKind.Rollback];

/**
 * "Cutucada" (D4.4, D18.6): só as pendentes da **mesma wallet** que
 * referenciam a transação, pulando as travadas. Usa o índice
 * `wager_transactions_pending_by_reference_ix`. O `now()` é o mesmo para
 * todas, e o claim desempata por `created_at` (D18.9).
 */
const NUDGE_DEPENDENTS_SQL = `
  UPDATE wager_transactions SET next_attempt_at = now()
   WHERE id IN (
     SELECT id FROM wager_transactions
      WHERE wallet_id = ? AND provider_id = ? AND reference_external_transaction_id = ?
        AND status = 'PENDING_REFERENCE'
      FOR UPDATE SKIP LOCKED)`;

/** O `now()` da transação (D18.12), truncado em milissegundos. */
const NOW_SQL = `SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`;

/** Record já carregado e travado na transação (por `lockById`/`lockPending`). */
function lockedRecord(em: EntityManager, id: string): WagerTransactionRecord {
  const record = em.getReference(WagerTransactionSchema, id);
  if (!wrap(record).isInitialized()) {
    throw new Error(`transação ${id} atualizada sem lockPending antes`);
  }
  return record;
}

const ISOLATION: Record<AppIsolationLevel, IsolationLevel> = {
  READ_COMMITTED: IsolationLevel.READ_COMMITTED,
  REPEATABLE_READ: IsolationLevel.REPEATABLE_READ,
};

/**
 * `em.transactional()` num `EntityManager` novo por chamada (D7.1): o que
 * os repositórios gravam vai num flush só, no commit, e o ORM ordena os
 * INSERTs pelas FKs (wallet → transação → lançamento). Um `UNIQUE` de key
 * ou de id externo violado no commit vira `DuplicateTransactionError`
 * (D3.6).
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly orm: MikroORM) {}

  async run<T>(
    work: (scope: TransactionScope) => Promise<T>,
    options: { isolation?: AppIsolationLevel } = {},
  ): Promise<T> {
    try {
      return await this.orm.em.fork().transactional((em) => work(scopeFor(em)), {
        isolationLevel: ISOLATION[options.isolation ?? "READ_COMMITTED"],
      });
    } catch (error) {
      const constraint = violatedUnique(error);
      if (constraint !== undefined && TRANSACTION_IDENTITY_UQS.has(constraint)) {
        throw new DuplicateTransactionError(constraint);
      }
      throw error;
    }
  }
}

function violatedUnique(error: unknown): string | undefined {
  return error instanceof UniqueConstraintViolationException
    ? (error as { constraint?: string }).constraint
    : undefined;
}

function scopeFor(em: EntityManager): TransactionScope {
  return {
    // `now()` é o início da transação no Postgres: o mesmo valor a cada
    // chamada, e o mesmo relógio do claim e da cutucada (D18.12). Sai em ISO
    // UTC com milissegundos (a precisão do `Date`): o MikroORM troca os
    // parsers do `pg`, e um `timestamptz` cru chegaria como string.
    async now() {
      const [row] = await em.execute<{ now: string }[]>(NOW_SQL);
      if (!row) throw new Error("SELECT now() não devolveu linha");
      return new Date(row.now);
    },
    wallets: walletRepository(em),
    transactions: transactionRepository(em),
    ledger: ledgerRepository(em),
    outbox: outboxWriter(em),
    reconciliationRuns: reconciliationRunRepository(em),
  };
}

function walletRepository(em: EntityManager): WalletRepository {
  return {
    async findById(id) {
      const record = await em.findOne(WalletSchema, id);
      return record ? walletFromRecord(record) : undefined;
    },
    async findIdByPlayerAndCurrency(playerId, currency) {
      const record = await em.findOne(
        WalletSchema,
        { playerId, currency },
        { fields: ["id"] },
      );
      return record?.id;
    },
    async lockById(id) {
      const record = await em.findOne(WalletSchema, id, {
        lockMode: LockMode.PESSIMISTIC_WRITE,
      });
      return record ? walletFromRecord(record) : undefined;
    },
    // O record gerenciado vem do `lockById`; o flush grava só o que mudou.
    // A `version` vai como o domínio a deixou (D7.2, D15.7).
    update(wallet: Wallet) {
      const record = em.getReference(WalletSchema, wallet.id);
      if (!wrap(record).isInitialized()) {
        throw new Error(`wallet ${wallet.id} atualizada sem lockById antes`);
      }
      const { balance, version, updatedAt } = walletToRecord(wallet);
      em.assign(record, { balance, version, updatedAt });
    },
    // Flush na hora: o UNIQUE é a barreira de duplicata (D6.3), e o erro
    // precisa sair daqui, não do commit.
    async insert(wallet: Wallet) {
      em.create(WalletSchema, walletToRecord(wallet));
      try {
        await em.flush();
      } catch (error) {
        if (violatedUnique(error) === WALLET_PLAYER_CURRENCY_UQ) {
          throw new DuplicateWalletError();
        }
        throw error;
      }
    },
  };
}

function transactionRepository(em: EntityManager): WagerTransactionRepository {
  const findOne = async (where: Partial<WagerTransactionRecord>) => {
    const record = await em.findOne(WagerTransactionSchema, where);
    return record ? wagerTransactionFromRecord(record) : undefined;
  };
  return {
    insert(tx: WagerTransaction, correlationId: string) {
      em.create(WagerTransactionSchema, {
        ...wagerTransactionToRecord(tx, {
          updatedAt: tx.processedAt ?? tx.createdAt,
          correlationId,
        }),
        // A pendente nasce vencida: o worker a pega no próximo tick (D17.4).
        nextAttemptAt:
          tx.status === WagerTransactionStatus.PendingReference ? tx.createdAt : null,
        attempts: 0,
        consecutiveErrors: 0,
        lockedUntil: null,
        lockedBy: null,
      });
    },
    async lockPending(id) {
      const record = await em.findOne(
        WagerTransactionSchema,
        { id },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (!record) return undefined;
      return {
        transaction: wagerTransactionFromRecord(record),
        control: {
          attempts: record.attempts ?? 0,
          consecutiveErrors: record.consecutiveErrors ?? 0,
        },
        correlationId: record.correlationId,
        lockedBy: record.lockedBy ?? null,
      };
    },
    // O record gerenciado vem do `lockPending`; o flush grava só o que
    // mudou. Colunas da submissão não mudam (trigger, D7.3).
    resolve(tx: WagerTransaction, control: PendingControl, at: Date) {
      const record = lockedRecord(em, tx.id);
      const next = wagerTransactionToRecord(tx, {
        updatedAt: at,
        correlationId: record.correlationId,
      });
      em.assign(record, {
        status: next.status,
        failureCode: next.failureCode,
        failureDetail: next.failureDetail,
        referenceTransactionId: next.referenceTransactionId,
        balanceAfter: next.balanceAfter,
        balanceAfterCurrency: next.balanceAfterCurrency,
        processedAt: next.processedAt,
        updatedAt: next.updatedAt,
        attempts: control.attempts,
        consecutiveErrors: control.consecutiveErrors,
        nextAttemptAt: null,
        lockedUntil: null,
        lockedBy: null,
      });
    },
    reschedule(id, control) {
      em.assign(lockedRecord(em, id), {
        attempts: control.attempts,
        consecutiveErrors: control.consecutiveErrors,
        nextAttemptAt: control.nextAttemptAt,
        lockedUntil: null,
        lockedBy: null,
      });
    },
    async nudgeDependents(tx: WagerTransaction) {
      // A OPENING não tem id externo: ninguém a referencia.
      if (tx.providerId === undefined || tx.externalTransactionId === undefined) return;
      await em.execute(NUDGE_DEPENDENTS_SQL, [tx.walletId, tx.providerId, tx.externalTransactionId]);
    },
    findById: (id) => findOne({ id }),
    findByProviderAndKey: (providerId, idempotencyKey) =>
      findOne({ providerId, idempotencyKey }),
    findByProviderAndExternalId: (providerId, externalTransactionId) =>
      findOne({ providerId, externalTransactionId }),
    async findReference(providerId, referenceExternalTransactionId) {
      const reference = await findOne({
        providerId,
        externalTransactionId: referenceExternalTransactionId,
      });
      if (!reference) return { found: false };
      // Só reversão PROCESSED conta (D1.1, D1.3).
      const reversals = await em.count(WagerTransactionSchema, {
        referenceTransactionId: reference.id,
        status: WagerTransactionStatus.Processed,
        kind: { $in: REVERSAL_KINDS },
      });
      return { found: true, transaction: reference, alreadyReversed: reversals > 0 };
    },
  };
}

function ledgerRepository(em: EntityManager): LedgerRepository {
  return {
    insert(entry: WalletLedgerEntry) {
      em.create(WalletLedgerEntrySchema, ledgerEntryToRecord(entry));
    },
    async listPage(walletId, afterVersion, limit) {
      const records = await em.find(
        WalletLedgerEntrySchema,
        { walletId, walletVersion: { $gt: afterVersion } },
        { orderBy: { walletVersion: "asc" }, limit },
      );
      return records.map(ledgerEntryFromRecord);
    },
    async listAll(walletId) {
      const records = await em.find(
        WalletLedgerEntrySchema,
        { walletId },
        { orderBy: { walletVersion: "asc" } },
      );
      return records.map(ledgerEntryFromRecord);
    },
  };
}

function outboxWriter(em: EntityManager): OutboxWriter {
  return {
    append(events: readonly IntegrationEvent<unknown>[], orderingKey: string) {
      for (const event of events) {
        em.create(OutboxMessageSchema, {
          id: event.eventId,
          aggregateId: event.aggregateId,
          orderingKey,
          eventType: event.eventType,
          payload: event.toJSON(),
          occurredAt: event.occurredAt,
          attempts: 0,
          nextAttemptAt: event.occurredAt,
        });
      }
    },
  };
}

function reconciliationRunRepository(
  em: EntityManager,
): ReconciliationRunRepository {
  return {
    insert(run: { id: string; report: WalletReconciliation; executedAt: Date }) {
      const { report } = run;
      em.create(ReconciliationRunSchema, {
        id: run.id,
        walletId: report.walletId,
        currency: report.storedBalance.currency,
        storedBalance: report.storedBalance.toString(),
        calculatedBalance: report.calculatedBalance.toString(),
        difference: report.difference.toString(),
        checkedEntries: report.checkedEntries,
        consistent: report.consistent,
        issues: report.issues,
        executedAt: run.executedAt,
      });
    },
  };
}

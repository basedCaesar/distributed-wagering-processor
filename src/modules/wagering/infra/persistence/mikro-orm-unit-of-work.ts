import {
  type EntityManager,
  IsolationLevel,
  UniqueConstraintViolationException,
} from "@mikro-orm/core";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { IntegrationEvent } from "../../domain/events/integration-event";
import type { WagerTransaction } from "../../domain/wager-transaction";
import type { Wallet } from "../../domain/wallet";
import type { WalletLedgerEntry } from "../../domain/wallet-ledger-entry";
import type { WalletReconciliation } from "../../domain/wallet-reconciliation";
import { DuplicateWalletError } from "../../application/errors";
import type {
  IsolationLevel as AppIsolationLevel,
  LedgerRepository,
  OutboxWriter,
  ReconciliationRunRepository,
  TransactionScope,
  UnitOfWork,
  WagerTransactionRepository,
  WalletRepository,
} from "../../application/ports";
import { OutboxMessageSchema } from "./outbox-message.schema";
import { ReconciliationRunSchema } from "./reconciliation-run.schema";
import { wagerTransactionToRecord } from "./wager-transaction.mapper";
import { WagerTransactionSchema } from "./wager-transaction.schema";
import {
  ledgerEntryFromRecord,
  ledgerEntryToRecord,
} from "./wallet-ledger-entry.mapper";
import { WalletLedgerEntrySchema } from "./wallet-ledger-entry.schema";
import { walletFromRecord, walletToRecord } from "./wallet.mapper";
import { WalletSchema } from "./wallet.schema";

const WALLET_PLAYER_CURRENCY_UQ = "wallets_player_currency_uq";

const ISOLATION: Record<AppIsolationLevel, IsolationLevel> = {
  READ_COMMITTED: IsolationLevel.READ_COMMITTED,
  REPEATABLE_READ: IsolationLevel.REPEATABLE_READ,
};

/**
 * `em.transactional()` num `EntityManager` novo por chamada (D7.1): o que
 * os repositórios gravam vai num flush só, no commit, e o ORM ordena os
 * INSERTs pelas FKs (wallet → transação → lançamento).
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly orm: MikroORM) {}

  run<T>(
    work: (scope: TransactionScope) => Promise<T>,
    options: { isolation?: AppIsolationLevel } = {},
  ): Promise<T> {
    return this.orm.em.fork().transactional((em) => work(scopeFor(em)), {
      isolationLevel: ISOLATION[options.isolation ?? "READ_COMMITTED"],
    });
  }
}

function scopeFor(em: EntityManager): TransactionScope {
  return {
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
    // Flush na hora: o UNIQUE é a barreira de duplicata (D6.3), e o erro
    // precisa sair daqui, não do commit.
    async insert(wallet: Wallet) {
      em.create(WalletSchema, walletToRecord(wallet));
      try {
        await em.flush();
      } catch (error) {
        if (
          error instanceof UniqueConstraintViolationException &&
          (error as { constraint?: string }).constraint ===
            WALLET_PLAYER_CURRENCY_UQ
        ) {
          throw new DuplicateWalletError();
        }
        throw error;
      }
    },
  };
}

function transactionRepository(em: EntityManager): WagerTransactionRepository {
  return {
    insert(tx: WagerTransaction, correlationId: string) {
      em.create(
        WagerTransactionSchema,
        wagerTransactionToRecord(tx, {
          updatedAt: tx.processedAt ?? tx.createdAt,
          correlationId,
        }),
      );
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

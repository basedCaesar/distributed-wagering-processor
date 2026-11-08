import { AccountingDomainError } from "../domain/accounting-error";
import { JournalEntry } from "../domain/journal-entry";
import { envelopeHash } from "./envelope-hash";
import { AccountingEventConflictError, AccountingEventRejectedError } from "./errors";
import type {
  AccountingIdGenerator,
  AccountingUnitOfWork,
  BalanceChangedHalf,
  EventHalf,
  TransactionProcessedHalf,
} from "./ports";

export type RecordResult = { kind: "duplicate" } | { kind: "waiting" } | { kind: "posted"; entryId: string };

const OTHER_HALF = {
  WalletBalanceChanged: "WagerTransactionProcessed",
  WagerTransactionProcessed: "WalletBalanceChanged",
} as const;

/** As duas metades contam a mesma mudança de saldo (D27.4). */
function assertSamePair(balance: BalanceChangedHalf, processed: TransactionProcessedHalf): void {
  if (balance.walletId !== processed.walletId) throw new AccountingEventRejectedError("metades de wallets diferentes");
  if (balance.walletVersion !== processed.walletVersion) throw new AccountingEventRejectedError("metades com versões diferentes");
  if (!balance.amount.equals(processed.amount)) throw new AccountingEventRejectedError("metades com valores diferentes");
  if (!balance.balanceAfter.equals(processed.balanceAfter)) {
    throw new AccountingEventRejectedError("metades com saldos finais diferentes");
  }
}

/**
 * O efeito do `accounting-consumer` (D27.1, D27.4), numa transação só:
 * 1. inbox por `(consumerName, eventId)` com o hash do envelope: duplicata
 *    sem efeito; outro conteúdo → conflito (permanente);
 * 2. lock da conta `PLAYER_WALLET` da wallet (moeda diferente → permanente);
 * 3. sob o lock: outra metade do mesmo tipo para a transação → conflito;
 *    grava a metade; se a outra já chegou, confere o par e grava o
 *    lançamento. Duas metades simultâneas esperam no mesmo lock, então a
 *    segunda sempre vê a primeira.
 *
 * Erro do domínio (`kind`/direção sem lançamento, valor zero) vira
 * `AccountingEventRejectedError`: o evento nunca vai virar lançamento.
 */
export class RecordEventHalfUseCase {
  constructor(
    private readonly uow: AccountingUnitOfWork,
    private readonly ids: AccountingIdGenerator,
  ) {}

  execute(half: EventHalf, envelope: unknown, consumerName: string): Promise<RecordResult> {
    const hash = envelopeHash(envelope);
    return this.uow.run(async (scope) => {
      const registration = await scope.registerInbox({ consumerName, messageId: half.eventId, hash });
      if (registration === "conflict") throw new AccountingEventConflictError("eventId já processado com outro conteúdo");
      if (registration === "duplicate") return { kind: "duplicate" };

      const account = await scope.lockPlayerAccount(half.walletId, half.amount.currency);
      if (account.currency !== half.amount.currency) {
        throw new AccountingEventRejectedError("moeda diferente da conta da wallet");
      }

      const same = await scope.findHalf(half.transactionId, half.type);
      if (same !== undefined) throw new AccountingEventConflictError("a transação já tem esta metade com outro eventId");
      const other = await scope.findHalf(half.transactionId, OTHER_HALF[half.type]);
      if (other === undefined) {
        await scope.insertHalf(half);
        return { kind: "waiting" };
      }

      const balance = (half.type === "WalletBalanceChanged" ? half : other) as BalanceChangedHalf;
      const processed = (half.type === "WagerTransactionProcessed" ? half : other) as TransactionProcessedHalf;
      assertSamePair(balance, processed);
      const entry = this.post(balance, processed);
      await scope.insertHalf(half);
      await scope.postEntry(entry, {
        balanceEventId: balance.eventId,
        processedEventId: processed.eventId,
        occurredAt: balance.occurredAt,
      });
      return { kind: "posted", entryId: entry.id };
    });
  }

  private post(balance: BalanceChangedHalf, processed: TransactionProcessedHalf): JournalEntry {
    try {
      return JournalEntry.post({
        id: this.ids.next(),
        transactionId: balance.transactionId,
        walletId: balance.walletId,
        walletVersion: balance.walletVersion,
        kind: processed.kind,
        walletDirection: balance.direction,
        amount: balance.amount,
      });
    } catch (error) {
      if (error instanceof AccountingDomainError) throw new AccountingEventRejectedError(error.message);
      throw error;
    }
  }
}

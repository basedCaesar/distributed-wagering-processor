import { InvalidWagerTransactionError } from "../domain/domain-error";
import type { EventContext } from "../domain/events/event-context";
import type { IntegrationEvent } from "../domain/events/integration-event";
import { WagerTransactionPendingReference } from "../domain/events/wager-transaction-pending-reference";
import { WagerTransactionProcessed } from "../domain/events/wager-transaction-processed";
import { WagerTransactionRejected } from "../domain/events/wager-transaction-rejected";
import { WalletBalanceChanged } from "../domain/events/wallet-balance-changed";
import type { Money } from "../domain/money";
import {
  WagerTransaction,
  type WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction";
import { applyWagerTransaction } from "../domain/wager-transaction-rules";
import {
  ConcurrentSubmissionError,
  DuplicateTransactionError,
  ExternalIdConflictError,
  IdempotencyKeyConflictError,
  InvalidSubmissionError,
  WalletNotFoundError,
} from "./errors";
import { payloadHash } from "./payload-hash";
import type {
  Clock,
  IdGenerator,
  OperationMeta,
  SubmissionMetrics,
  UnitOfWork,
} from "./ports";

/** O mesmo comando para o HTTP e para a fila (R-10-03, D3.3). */
export interface SubmitWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
}

export interface SubmissionResult {
  /** Estado atual: no replay, o que está gravado (D3.4). */
  transaction: WagerTransaction;
  idempotentReplay: boolean;
}

/**
 * Submissão de uma transação do provedor (R-09-10..17, D3, D4.1, D7.2).
 *
 * 1. Valida o que é decidível só pelo payload (`400`, D5) e calcula o hash.
 * 2. Checagem rápida da key, só leitura, para replays antigos (D3.6).
 * 3. Numa transação: trava a wallet; checagem **autoritativa** da key e do
 *    id externo; busca da referência; regras do domínio; transação,
 *    lançamento, saldo e eventos da outbox, tudo junto (R-06-52).
 * 4. Se um `UNIQUE` de key ou de id externo barrar o commit (outra wallet,
 *    outro lock), repete uma vez e cai no replay ou no `409` (D3.6). Se
 *    barrar de novo, `503` (D17.6).
 *
 * Cada duplicata de key é contada pela camada que a pegou (D11.2, D17.7).
 *
 * Nunca publica: eventos viram linhas da outbox (D9).
 */
export class SubmitWagerTransactionUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly metrics: SubmissionMetrics,
  ) {}

  async execute(
    command: SubmitWagerTransactionCommand,
    meta: OperationMeta,
  ): Promise<SubmissionResult> {
    const hash = payloadHash(command);
    // Valida antes de tocar o banco: inválido nunca é gravado (D5).
    this.build(command, hash);

    const known = await this.uow.run((tx) =>
      tx.transactions.findByProviderAndKey(command.providerId, command.idempotencyKey),
    );
    if (known) {
      this.metrics.countDuplicate("fast_path");
      return replayOf(known, hash);
    }

    try {
      return await this.process(command, hash, meta, "lock");
    } catch (error) {
      if (!(error instanceof DuplicateTransactionError)) throw error;
      this.metrics.countDuplicate("unique_index");
    }
    // A transação foi desfeita inteira; a nova tentativa enxerga a vencedora.
    // A duplicata já foi contada pelo índice, então a repetição não conta.
    try {
      return await this.process(command, hash, meta, undefined);
    } catch (error) {
      if (!(error instanceof DuplicateTransactionError)) throw error;
      this.metrics.countDuplicate("unique_index");
      // Bateu de novo: conflito transitório, o reenvio resolve (D17.6).
      throw new ConcurrentSubmissionError();
    }
  }

  /** `countAs`: a camada que conta a duplicata achada sob o lock; `undefined` na repetição. */
  private process(
    command: SubmitWagerTransactionCommand,
    hash: string,
    meta: OperationMeta,
    countAs: "lock" | undefined,
  ): Promise<SubmissionResult> {
    return this.uow.run(async (tx) => {
      // Ordem de locks: wallet, depois linhas da mesma wallet (CLAUDE.md, D7.2).
      const wallet = await tx.wallets.lockById(command.walletId);
      if (!wallet) throw new WalletNotFoundError();

      const existing = await tx.transactions.findByProviderAndKey(
        command.providerId,
        command.idempotencyKey,
      );
      if (existing) {
        if (countAs) this.metrics.countDuplicate(countAs);
        return replayOf(existing, hash);
      }
      const sameExternal = await tx.transactions.findByProviderAndExternalId(
        command.providerId,
        command.externalTransactionId,
      );
      if (sameExternal) throw new ExternalIdConflictError(sameExternal.id);

      const transaction = this.build(command, hash);
      const reference =
        command.referenceExternalTransactionId === undefined
          ? undefined
          : await tx.transactions.findReference(
              command.providerId,
              command.referenceExternalTransactionId,
            );
      const at = transaction.createdAt;
      const outcome = applyWagerTransaction({
        wallet,
        transaction,
        reference,
        entryId: this.ids.next(),
        at,
      });

      const ctx = (): EventContext => ({
        eventId: this.ids.next(),
        correlationId: meta.correlationId,
        causationId: meta.causationId,
        occurredAt: at,
      });
      const events: IntegrationEvent<unknown>[] = [];
      tx.transactions.insert(transaction, meta.correlationId);
      switch (outcome.status) {
        case WagerTransactionStatus.Processed:
          events.push(WagerTransactionProcessed.from(transaction, outcome.entry, ctx()));
          if (outcome.entry) {
            tx.wallets.update(wallet);
            tx.ledger.insert(outcome.entry);
            events.push(WalletBalanceChanged.from(wallet, outcome.entry, ctx()));
          }
          break;
        case WagerTransactionStatus.Rejected:
          events.push(WagerTransactionRejected.from(transaction, ctx()));
          break;
        case WagerTransactionStatus.PendingReference:
          // Nasce aqui, então sempre é a transição: um evento só (D4.6).
          events.push(WagerTransactionPendingReference.from(transaction, ctx()));
          break;
      }
      tx.outbox.append(events, wallet.id);
      return { transaction, idempotentReplay: false };
    });
  }

  /** `WagerTransaction.create` valida kind, referência por kind e sinal do valor (D1.5, D2.3). */
  private build(command: SubmitWagerTransactionCommand, hash: string): WagerTransaction {
    try {
      return WagerTransaction.create({
        id: this.ids.next(),
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash: hash,
        walletId: command.walletId,
        playerId: command.playerId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: command.kind,
        money: command.money,
        referenceExternalTransactionId: command.referenceExternalTransactionId,
        createdAt: this.clock.now(),
      });
    } catch (error) {
      if (!(error instanceof InvalidWagerTransactionError)) throw error;
      throw new InvalidSubmissionError(error.reason);
    }
  }
}

/** Mesma key: mesmo hash é replay do estado atual (D3.4); outro hash é conflito (R-09-16). */
function replayOf(existing: WagerTransaction, hash: string): SubmissionResult {
  if (!existing.matchesPayload(hash)) {
    throw new IdempotencyKeyConflictError(existing.id);
  }
  return { transaction: existing, idempotentReplay: true };
}

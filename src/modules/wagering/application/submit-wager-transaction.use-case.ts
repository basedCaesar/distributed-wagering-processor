import { InvalidWagerTransactionError } from "../domain/domain-error";
import type { EventContext } from "../domain/events/event-context";
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
  InboxConflictError,
  InvalidSubmissionError,
  WalletNotFoundError,
} from "./errors";
import { inboxHash, payloadHash } from "./payload-hash";
import type {
  IdGenerator,
  InboxEntry,
  OperationMeta,
  SubmissionMetrics,
  UnitOfWork,
} from "./ports";
import { eventsForTransition } from "./transaction-events";

/** Horário da cópia que só valida o payload, antes do banco (nunca é gravada). */
const VALIDATION_ONLY = new Date(0);

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

/** A mensagem da fila que trouxe o comando (R-10-04, D3.7). */
export interface InboxMessage {
  consumerName: string;
  /** O `messageId` do corpo (D3.7). */
  messageId: string;
  /** O `type` do envelope; entra no hash da inbox (D3.8). */
  type: string;
}

/** A mensagem já foi processada (mesmo `messageId` e hash): nada a fazer (D19.4). */
export interface DuplicateMessage {
  duplicateMessage: true;
}

const DUPLICATE_MESSAGE: DuplicateMessage = { duplicateMessage: true };

/**
 * Submissão de uma transação do provedor (R-09-10..17, D3, D4.1, D7.2).
 *
 * 1. Valida o que é decidível só pelo payload (`400`, D5) e calcula o hash.
 * 2. Checagem rápida da key, só leitura, para replays antigos (D3.6).
 * 3. Numa transação: trava a wallet; checagem **autoritativa** da key e do
 *    id externo; busca da referência; regras do domínio; transação,
 *    lançamento, saldo, eventos da outbox e, se terminal, a "cutucada" das
 *    pendentes da mesma wallet que a esperam, tudo junto (R-06-52, D4.4).
 * 4. Se um `UNIQUE` de key ou de id externo barrar o commit (outra wallet,
 *    outro lock), repete uma vez e cai no replay ou no `409` (D3.6). Se
 *    barrar de novo, `503` (D17.6).
 *
 * Cada duplicata de key é contada pela camada que a pegou (D11.2, D17.7).
 *
 * **Fila** (R-10-03, D19.4): o consumidor chama este mesmo use case com a
 * `inbox`. Aí o registro da inbox é o primeiro comando de cada transação,
 * antes do lock da wallet, e é commitado junto com o efeito. A checagem
 * rápida é pulada (só lê e não poderia gravar a inbox). Mensagem já
 * processada → `DuplicateMessage`; mesmo `messageId` com outro conteúdo →
 * `InboxConflictError`.
 *
 * Nunca publica: eventos viram linhas da outbox (D9).
 */
export class SubmitWagerTransactionUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly metrics: SubmissionMetrics,
  ) {}

  execute(command: SubmitWagerTransactionCommand, meta: OperationMeta): Promise<SubmissionResult>;
  execute(
    command: SubmitWagerTransactionCommand,
    meta: OperationMeta,
    inbox: InboxMessage,
  ): Promise<SubmissionResult | DuplicateMessage>;
  async execute(
    command: SubmitWagerTransactionCommand,
    meta: OperationMeta,
    inbox?: InboxMessage,
  ): Promise<SubmissionResult | DuplicateMessage> {
    const hash = payloadHash(command);
    // Valida antes de tocar o banco: inválido nunca é gravado (D5). Esta
    // cópia é descartada, então o horário não importa.
    this.build(command, hash, VALIDATION_ONLY);
    const entry: InboxEntry | undefined = inbox && {
      consumerName: inbox.consumerName,
      messageId: inbox.messageId,
      hash: inboxHash(hash, inbox.type),
    };

    if (!entry) {
      const known = await this.uow.run((tx) =>
        tx.transactions.findByProviderAndKey(command.providerId, command.idempotencyKey),
      );
      if (known) {
        this.metrics.countDuplicate("fast_path");
        return replayOf(known, hash);
      }
    }

    try {
      return await this.process(command, hash, meta, entry, "lock");
    } catch (error) {
      if (!(error instanceof DuplicateTransactionError)) throw error;
      this.metrics.countDuplicate("unique_index");
    }
    // A transação foi desfeita inteira (inclusive a inbox); a nova tentativa
    // enxerga a vencedora. A duplicata já foi contada pelo índice, então a
    // repetição não conta.
    try {
      return await this.process(command, hash, meta, entry, undefined);
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
    inbox: InboxEntry | undefined,
    countAs: "lock" | undefined,
  ): Promise<SubmissionResult | DuplicateMessage> {
    return this.uow.run(async (tx) => {
      // Ordem de locks: chave da inbox, wallet, linhas da mesma wallet (CLAUDE.md, D7.2).
      if (inbox) {
        const registration = await tx.inbox.register(inbox);
        if (registration === "conflict") throw new InboxConflictError();
        if (registration === "duplicate") {
          this.metrics.countDuplicate("inbox");
          return DUPLICATE_MESSAGE;
        }
      }
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

      // Todo horário gravado vem do now() da transação no banco (D18.12).
      const transaction = this.build(command, hash, await tx.now());
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

      const context = (): EventContext => ({
        eventId: this.ids.next(),
        correlationId: meta.correlationId,
        causationId: meta.causationId,
        occurredAt: at,
      });
      const entry =
        outcome.status === WagerTransactionStatus.Processed ? outcome.entry : undefined;
      tx.transactions.insert(transaction, meta.correlationId);
      if (entry) {
        tx.wallets.update(wallet);
        tx.ledger.insert(entry);
      }
      // A pendente nasce aqui, então é sempre a transição: um evento só (D4.6).
      tx.outbox.append(eventsForTransition({ transaction, wallet, entry, context }), wallet.id);
      // Terminal: as pendentes da mesma wallet que a esperam vencem agora (D4.4).
      if (transaction.isTerminal()) await tx.transactions.nudgeDependents(transaction);
      return { transaction, idempotentReplay: false };
    });
  }

  /** `WagerTransaction.create` valida kind, referência por kind e sinal do valor (D1.5, D2.3). */
  private build(
    command: SubmitWagerTransactionCommand,
    hash: string,
    createdAt: Date,
  ): WagerTransaction {
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
        createdAt,
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

import type { EventContext } from "../domain/events/event-context";
import type { IntegrationEvent } from "../domain/events/integration-event";
import { WagerTransactionProcessed } from "../domain/events/wager-transaction-processed";
import { WalletBalanceChanged } from "../domain/events/wallet-balance-changed";
import { WalletOpened } from "../domain/events/wallet-opened";
import type { Money } from "../domain/money";
import type { Wallet } from "../domain/wallet";
import { openWallet } from "../domain/wager-transaction-rules";
import { DuplicateWalletError, WalletAlreadyExistsError } from "./errors";
import type { IdGenerator, OperationMeta, UnitOfWork } from "./ports";

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: Money;
}

/**
 * `POST /wallets` (R-09-02..05). Wallet, `OPENING`, lançamento e eventos
 * numa transação SQL só (R-09-03, D6.2, D9.4). Sem pré-checagem: o
 * `UNIQUE (player_id, currency)` é a barreira, e quem perde a corrida
 * recebe o id da wallet que ganhou (D6.3). Os horários vêm do `now()` da
 * transação no banco (D18.12).
 */
export class OpenWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: OpenWalletCommand, meta: OperationMeta): Promise<Wallet> {
    try {
      return await this.uow.run(async (tx) => {
        const at = await tx.now();
        const { wallet, opening } = openWallet({
          walletId: this.ids.next(),
          playerId: command.playerId,
          initialBalance: command.initialBalance,
          openingTransactionId: this.ids.next(),
          openingEntryId: this.ids.next(),
          at,
        });
        const ctx = (): EventContext => ({
          eventId: this.ids.next(),
          correlationId: meta.correlationId,
          causationId: meta.causationId,
          occurredAt: at,
        });
        const events: IntegrationEvent<unknown>[] = [WalletOpened.from(wallet, ctx())];
        if (opening) {
          events.push(
            WagerTransactionProcessed.from(opening.transaction, opening.entry, ctx()),
            WalletBalanceChanged.from(wallet, opening.entry, ctx()),
          );
        }

        await tx.wallets.insert(wallet);
        if (opening) {
          tx.transactions.insert(opening.transaction, meta.correlationId);
          tx.ledger.insert(opening.entry);
        }
        tx.outbox.append(events, wallet.id);
        return wallet;
      });
    } catch (error) {
      if (!(error instanceof DuplicateWalletError)) throw error;
      // A moeda da wallet é a do saldo inicial (D6.2).
      const existingId = await this.uow.run((tx) =>
        tx.wallets.findIdByPlayerAndCurrency(command.playerId, command.initialBalance.currency),
      );
      if (existingId === undefined) throw error;
      throw new WalletAlreadyExistsError(existingId);
    }
  }
}

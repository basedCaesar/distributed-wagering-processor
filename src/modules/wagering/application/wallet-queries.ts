import type { Wallet } from "../domain/wallet";
import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import { WalletNotFoundError } from "./errors";
import { decodeLedgerCursor, encodeLedgerCursor } from "./ledger-cursor";
import type { UnitOfWork } from "./ports";

export interface LedgerPage {
  items: WalletLedgerEntry[];
  /** `null` na última página (D6.8). */
  nextCursor: string | null;
}

/** `GET /wallets/:id` e `GET /wallets/:id/ledger` (R-09-06, R-09-07). */
export class WalletQueries {
  constructor(private readonly uow: UnitOfWork) {}

  async getWallet(walletId: string): Promise<Wallet> {
    const wallet = await this.uow.run((tx) => tx.wallets.findById(walletId));
    if (!wallet) throw new WalletNotFoundError();
    return wallet;
  }

  /** Busca `limit + 1` para saber se há próxima página sem outra consulta. */
  async listLedger(
    walletId: string,
    options: { cursor?: string; limit: number },
  ): Promise<LedgerPage> {
    const afterVersion =
      options.cursor === undefined ? 0 : decodeLedgerCursor(options.cursor);
    const entries = await this.uow.run(async (tx) => {
      if (!(await tx.wallets.findById(walletId))) throw new WalletNotFoundError();
      return tx.ledger.listPage(walletId, afterVersion, options.limit + 1);
    });
    const items = entries.slice(0, options.limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        entries.length > options.limit && last
          ? encodeLedgerCursor(last.walletVersion)
          : null,
    };
  }
}

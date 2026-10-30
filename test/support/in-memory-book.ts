import type { Money } from "../../src/modules/wagering/domain/money";
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/modules/wagering/domain/wager-transaction";
import {
  applyWagerTransaction,
  openWallet,
  type ReferenceLookup,
  type WagerTransactionOutcome,
} from "../../src/modules/wagering/domain/wager-transaction-rules";
import type { Wallet } from "../../src/modules/wagering/domain/wallet";
import type { WalletLedgerEntry } from "../../src/modules/wagering/domain/wallet-ledger-entry";
import type { WalletBook } from "./ledger-invariant";
import { submissionProps, T0 } from "./wager-fixtures";

/**
 * Faz em memória o papel do repositório (que chega na S2/S4): resolve a
 * referência por (providerId, referenceExternalTransactionId) e calcula
 * `alreadyReversed` como "existe reversão PROCESSED dela" (D1.1, D1.3).
 */
export class InMemoryBook {
  private readonly wallets = new Map<string, Wallet>();
  private readonly transactions: WagerTransaction[] = [];
  private readonly entries: WalletLedgerEntry[] = [];
  private sequence = 0;

  openWallet(walletId: string, playerId: string, initial: Money): Wallet {
    const { wallet, opening } = openWallet({
      walletId,
      playerId,
      initialBalance: initial,
      openingTransactionId: `${walletId}-opening`,
      openingEntryId: `${walletId}-opening-entry`,
      at: T0,
    });
    this.wallets.set(walletId, wallet);
    if (opening) {
      this.transactions.push(opening.transaction);
      this.entries.push(opening.entry);
    }
    return wallet;
  }

  wallet(walletId = "wallet-1"): Wallet {
    const wallet = this.wallets.get(walletId);
    if (!wallet) throw new Error(`wallet ${walletId} não existe no livro`);
    return wallet;
  }

  submit(overrides: Partial<CreateWagerTransactionProps> = {}): {
    tx: WagerTransaction;
    outcome: WagerTransactionOutcome;
  } {
    const tx = WagerTransaction.create(submissionProps(overrides));
    const outcome = this.apply(tx);
    this.transactions.push(tx);
    return { tx, outcome };
  }

  /** O que o worker faz com uma pendente (S5). */
  retry(tx: WagerTransaction): WagerTransactionOutcome {
    return this.apply(tx);
  }

  /** Grava uma transação já pronta (para montar referências fora do comum). */
  store(tx: WagerTransaction): void {
    this.transactions.push(tx);
  }

  books(): WalletBook[] {
    return [...this.wallets.values()].map((wallet) => ({
      wallet,
      entries: this.entries.filter((entry) => entry.walletId === wallet.id),
    }));
  }

  private apply(tx: WagerTransaction): WagerTransactionOutcome {
    const outcome = applyWagerTransaction({
      wallet: this.wallet(tx.walletId),
      transaction: tx,
      reference: this.lookup(tx),
      entryId: `entry-${++this.sequence}`,
      at: T0,
    });
    if (outcome.status === WagerTransactionStatus.Processed && outcome.entry) {
      this.entries.push(outcome.entry);
    }
    return outcome;
  }

  private lookup(tx: WagerTransaction): ReferenceLookup | undefined {
    const externalId = tx.referenceExternalTransactionId;
    if (externalId === undefined) return undefined;

    const reference = this.transactions.find(
      (candidate) =>
        candidate.providerId === tx.providerId &&
        candidate.externalTransactionId === externalId,
    );
    if (!reference) return { found: false };

    const alreadyReversed = this.transactions.some(
      (candidate) =>
        candidate.status === WagerTransactionStatus.Processed &&
        (candidate.kind === WagerTransactionKind.Refund ||
          candidate.kind === WagerTransactionKind.Rollback) &&
        candidate.referenceTransactionId === reference.id,
    );
    return { found: true, transaction: reference, alreadyReversed };
  }
}

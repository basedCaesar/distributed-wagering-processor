import {
  InvalidTransactionStateError,
  InvalidWalletOperationError,
} from "./domain-error";
import { FailureCode, ReferenceScopeField } from "./failure-code";
import type { Money } from "./money";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "./wager-transaction";
import { Wallet } from "./wallet";
import { LedgerDirection, type WalletLedgerEntry } from "./wallet-ledger-entry";

/**
 * Resultado da busca da referência por (providerId,
 * referenceExternalTransactionId), feita pelo repositório sob o lock da
 * wallet. `alreadyReversed`: existe reversão `PROCESSED` dela, de qualquer
 * tipo (D1.1, D1.3).
 */
export type ReferenceLookup =
  | { found: false }
  | { found: true; transaction: WagerTransaction; alreadyReversed: boolean };

export interface ApplyWagerTransactionInput {
  /** A wallet da transação, já travada (D7.2). */
  wallet: Wallet;
  transaction: WagerTransaction;
  /** `undefined` se e só se a transação não tem referência. */
  reference: ReferenceLookup | undefined;
  /** Id do lançamento, caso o saldo mude (D6.6). */
  entryId: string;
  at: Date;
}

export type WagerTransactionOutcome =
  | {
      status: WagerTransactionStatus.Processed;
      entry: WalletLedgerEntry | undefined;
    }
  | {
      status: WagerTransactionStatus.Rejected;
      failureCode: FailureCode;
      failureDetail?: ReferenceScopeField;
    }
  | {
      status: WagerTransactionStatus.PendingReference;
      /** false quando já estava pendente: nada a gravar nem emitir (D4.6). */
      transitioned: boolean;
    };

type Verdict =
  | { kind: "apply" }
  | { kind: "wait" }
  | { kind: "reject"; code: FailureCode; detail?: ReferenceScopeField };

const ALLOWED_REFERENCE_KINDS: Readonly<
  Partial<Record<WagerTransactionKind, ReadonlySet<WagerTransactionKind>>>
> = {
  [WagerTransactionKind.Win]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Loss]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Refund]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Rollback]: new Set([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ]),
};

/**
 * Serviço de domínio que aplica as regras de cada kind (D1, D5) e coordena
 * os agregados `Wallet` e `WagerTransaction` (D6.5). Checagens na ordem da
 * D14.2; a primeira violação vence.
 */
export function applyWagerTransaction(
  input: ApplyWagerTransactionInput,
): WagerTransactionOutcome {
  const { wallet, transaction: tx, reference, entryId, at } = input;
  // Terminal não muda (D4.5): o replay devolve o estado gravado (D3.4).
  if (tx.isTerminal()) {
    throw new InvalidTransactionStateError(
      `Transação terminal não é reaplicada: ${tx.status}`,
    );
  }
  if (tx.walletId !== wallet.id) {
    throw new InvalidWalletOperationError("Transação de outra wallet");
  }
  if (
    (tx.referenceExternalTransactionId === undefined) !==
    (reference === undefined)
  ) {
    throw new InvalidWalletOperationError(
      "Busca da referência não corresponde à transação",
    );
  }

  const referenceTx = reference?.found ? reference.transaction : undefined;
  const verdict = decide(wallet, tx, reference);

  if (verdict.kind === "wait") {
    const transitioned = tx.status === WagerTransactionStatus.Pending;
    if (transitioned) tx.markPendingReference();
    return { status: WagerTransactionStatus.PendingReference, transitioned };
  }

  if (verdict.kind === "apply") {
    const settled = settle(wallet, tx, referenceTx, entryId, at);
    if (settled.kind === "reject") {
      return reject(wallet, tx, settled.code);
    }
    tx.markProcessed({
      referenceTransactionId: referenceTx?.id,
      balanceAfter: wallet.balance,
      at,
    });
    return { status: WagerTransactionStatus.Processed, entry: settled.entry };
  }

  return reject(wallet, tx, verdict.code, verdict.detail);
}

/** Checagens 1 a 8 da D14.2. */
function decide(
  wallet: Wallet,
  tx: WagerTransaction,
  reference: ReferenceLookup | undefined,
): Verdict {
  // 1. wallet do player
  if (tx.playerId !== wallet.playerId) {
    return { kind: "reject", code: FailureCode.WalletPlayerMismatch };
  }
  // 2. moeda da wallet (R-06-26)
  if (tx.money.currency !== wallet.currency) {
    return { kind: "reject", code: FailureCode.CurrencyMismatch };
  }
  if (!reference) return { kind: "apply" };

  // 3. referência ausente → espera (R-07-13)
  if (!reference.found) return { kind: "wait" };
  const ref = reference.transaction;

  // 4. escopo (R-07-07)
  const scopeField = scopeMismatch(tx, ref);
  if (scopeField) {
    return {
      kind: "reject",
      code: FailureCode.ReferenceScopeMismatch,
      detail: scopeField,
    };
  }
  // 5. tipo (R-07-08, D1.5)
  if (!ALLOWED_REFERENCE_KINDS[tx.kind]?.has(ref.kind)) {
    return { kind: "reject", code: FailureCode.ReferenceKindNotAllowed };
  }
  // 6. estado (D1.4)
  if (!ref.isTerminal()) return { kind: "wait" };
  if (ref.status !== WagerTransactionStatus.Processed) {
    return { kind: "reject", code: FailureCode.ReferenceNotProcessed };
  }
  if (tx.requiresReference()) {
    // 7. uma reversão PROCESSED por referência (D1.1)
    if (reference.alreadyReversed) {
      return { kind: "reject", code: FailureCode.ReferenceAlreadyReversed };
    }
    // 8. valor igual ao da referência (R-07-10)
    if (!tx.money.equals(ref.money)) {
      return { kind: "reject", code: FailureCode.AmountMismatch };
    }
  }
  return { kind: "apply" };
}

/** Checagem 9 da D14.2 e a aplicação na wallet. */
function settle(
  wallet: Wallet,
  tx: WagerTransaction,
  reference: WagerTransaction | undefined,
  entryId: string,
  at: Date,
):
  | { kind: "applied"; entry: WalletLedgerEntry | undefined }
  | { kind: "reject"; code: FailureCode } {
  if (!tx.affectsBalance()) return { kind: "applied", entry: undefined };

  const movement = { money: tx.money, transactionId: tx.id, entryId, at };
  if (tx.ledgerDirectionFor(reference) === LedgerDirection.Debit) {
    if (!wallet.canDebit(tx.money)) {
      return {
        kind: "reject",
        // R-07-14: reversão sem saldo tem código próprio.
        code: tx.requiresReference()
          ? FailureCode.InsufficientFundsForReversal
          : FailureCode.InsufficientFunds,
      };
    }
    return { kind: "applied", entry: wallet.debit(movement) };
  }
  if (!wallet.canCredit(tx.money)) {
    return { kind: "reject", code: FailureCode.BalanceLimitExceeded };
  }
  return { kind: "applied", entry: wallet.credit(movement) };
}

function scopeMismatch(
  tx: WagerTransaction,
  ref: WagerTransaction,
): ReferenceScopeField | undefined {
  if (ref.playerId !== tx.playerId) return ReferenceScopeField.Player;
  if (ref.walletId !== tx.walletId) return ReferenceScopeField.Wallet;
  if (ref.money.currency !== tx.money.currency) {
    return ReferenceScopeField.Currency;
  }
  if (ref.roundId !== tx.roundId) return ReferenceScopeField.Round;
  return undefined;
}

/**
 * Prazo da pendência esgotado (R-07-22, D4.3): `REJECTED` com
 * `REFERENCE_NOT_FOUND` e o saldo atual da wallet travada. Só a partir de
 * `PENDING_REFERENCE`; quem decide que o prazo passou é o worker, depois de
 * reavaliar a referência (D18.5).
 */
export function expirePendingReference(
  wallet: Wallet,
  tx: WagerTransaction,
): WagerTransactionOutcome {
  if (tx.status !== WagerTransactionStatus.PendingReference) {
    throw new InvalidTransactionStateError(
      `Só uma PENDING_REFERENCE expira: ${tx.status}`,
    );
  }
  if (tx.walletId !== wallet.id) {
    throw new InvalidWalletOperationError("Transação de outra wallet");
  }
  return reject(wallet, tx, FailureCode.ReferenceNotFound);
}

/** Rejeição não muda saldo nem gera lançamento (R-07-11). */
function reject(
  wallet: Wallet,
  tx: WagerTransaction,
  code: FailureCode,
  detail?: ReferenceScopeField,
): WagerTransactionOutcome {
  tx.reject(code, { balanceAfter: wallet.balance, detail });
  return detail
    ? {
        status: WagerTransactionStatus.Rejected,
        failureCode: code,
        failureDetail: detail,
      }
    : { status: WagerTransactionStatus.Rejected, failureCode: code };
}

export interface OpenWalletInput {
  walletId: string;
  playerId: string;
  initialBalance: Money;
  openingTransactionId: string;
  openingEntryId: string;
  at: Date;
}

/**
 * Abre a wallet e, se o saldo inicial for positivo, a `OPENING` já
 * `PROCESSED` com o lançamento de `walletVersion` 1 (D2.3, D6.1, D6.2).
 */
export function openWallet(input: OpenWalletInput): {
  wallet: Wallet;
  opening:
    | { transaction: WagerTransaction; entry: WalletLedgerEntry }
    | undefined;
} {
  const { wallet, openingEntry } = Wallet.open({
    id: input.walletId,
    playerId: input.playerId,
    initialBalance: input.initialBalance,
    openingTransactionId: input.openingTransactionId,
    openingEntryId: input.openingEntryId,
    at: input.at,
  });
  if (!openingEntry) return { wallet, opening: undefined };

  const transaction = WagerTransaction.opening({
    id: input.openingTransactionId,
    walletId: wallet.id,
    playerId: wallet.playerId,
    money: input.initialBalance,
    createdAt: input.at,
  });
  transaction.markProcessed({ balanceAfter: wallet.balance, at: input.at });
  return { wallet, opening: { transaction, entry: openingEntry } };
}

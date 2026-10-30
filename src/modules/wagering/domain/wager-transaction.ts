import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from "./domain-error";
import { FailureCode, type ReferenceScopeField } from "./failure-code";
import type { Money } from "./money";
import { LedgerDirection } from "./wallet-ledger-entry";

export enum WagerTransactionKind {
  /** Interno: crédito de abertura da wallet (R-06-38). */
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  /** Só em memória: nunca é gravado (D4.1). */
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

const TERMINAL: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/** Transições válidas (D4.5, R-06-37). Terminais não saem (R-06-36). */
const TRANSITIONS: Readonly<
  Record<WagerTransactionStatus, ReadonlySet<WagerTransactionStatus>>
> = {
  [WagerTransactionStatus.Pending]: new Set([
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.PendingReference,
  ]),
  [WagerTransactionStatus.PendingReference]: new Set([
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ]),
  [WagerTransactionStatus.Processed]: new Set(),
  [WagerTransactionStatus.Rejected]: new Set(),
  [WagerTransactionStatus.Failed]: new Set(),
};

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
}

export interface OpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  createdAt: Date;
}

/** Campos do provedor ficam `undefined` na `OPENING` (D6.1, D14.5). */
export interface WagerTransactionState {
  id: string;
  providerId: string | undefined;
  externalTransactionId: string | undefined;
  idempotencyKey: string | undefined;
  payloadHash: string | undefined;
  walletId: string;
  playerId: string;
  roundId: string | undefined;
  gameId: string | undefined;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  failureDetail: ReferenceScopeField | undefined;
  balanceAfter: Money | undefined;
  processedAt: Date | undefined;
}

export interface MarkProcessedProps {
  /** Id interno da referência; obrigatório quando há referência externa (D7.3). */
  referenceTransactionId?: string;
  /** Saldo depois de aplicar, ou o do momento da decisão no `LOSS` (D3.5). */
  balanceAfter: Money;
  at: Date;
}

export interface RejectProps {
  /** Saldo no momento da decisão (D3.5). */
  balanceAfter: Money;
  /** Só e sempre com `REFERENCE_SCOPE_MISMATCH` (D14.3). */
  detail?: ReferenceScopeField;
}

/**
 * Agregado da transação (D6.5). Nasce `PENDING` e é decidida na mesma
 * transação SQL (D4.1). As tentativas do worker ficam fora (D4.5).
 */
export class WagerTransaction {
  private constructor(
    readonly id: string,
    readonly providerId: string | undefined,
    readonly externalTransactionId: string | undefined,
    readonly idempotencyKey: string | undefined,
    readonly payloadHash: string | undefined,
    readonly walletId: string,
    readonly playerId: string,
    readonly roundId: string | undefined,
    readonly gameId: string | undefined,
    readonly kind: WagerTransactionKind,
    readonly money: Money,
    /** Id no provedor — não o id interno. */
    readonly referenceExternalTransactionId: string | undefined,
    readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _failureDetail: ReferenceScopeField | undefined,
    private _balanceAfter: Money | undefined,
    private _processedAt: Date | undefined,
  ) {}

  /**
   * Submissão do provedor. Valida o que é decidível só pelo payload
   * (D5): kind, exigência de referência (D1.5) e sinal do valor (D2.3).
   */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const { kind, money, referenceExternalTransactionId } = props;
    if (kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError("OPENING_NOT_SUBMITTABLE");
    }
    const hasReference = referenceExternalTransactionId !== undefined;
    if (isReversal(kind) && !hasReference) {
      throw new InvalidWagerTransactionError("REFERENCE_REQUIRED");
    }
    if (kind === WagerTransactionKind.Bet && hasReference) {
      throw new InvalidWagerTransactionError("REFERENCE_FORBIDDEN");
    }
    if (money.isNegative()) {
      throw new InvalidWagerTransactionError("AMOUNT_MUST_NOT_BE_NEGATIVE");
    }
    if (kind !== WagerTransactionKind.Loss && !money.isPositive()) {
      throw new InvalidWagerTransactionError("AMOUNT_MUST_BE_POSITIVE");
    }
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      kind,
      money,
      referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  }

  /** Crédito de abertura, sem campos do provedor (D6.1, D14.5). */
  static opening(props: OpeningTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError("AMOUNT_MUST_BE_POSITIVE");
    }
    return new WagerTransaction(
      props.id,
      undefined,
      undefined,
      undefined,
      undefined,
      props.walletId,
      props.playerId,
      undefined,
      undefined,
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      props.createdAt,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  }

  /** Reconstrução a partir da persistência — não revalida (R-06-03). */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.failureDetail,
      state.balanceAfter,
      state.processedAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get failureDetail(): ReferenceScopeField | undefined {
    return this._failureDetail;
  }

  get balanceAfter(): Money | undefined {
    return this._balanceAfter;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  // ---- transições (D4.5, D14.6)

  markProcessed(props: MarkProcessedProps): void {
    this.assertCanMoveTo(WagerTransactionStatus.Processed);
    const hasExternal = this.referenceExternalTransactionId !== undefined;
    const hasInternal = props.referenceTransactionId !== undefined;
    if (hasExternal !== hasInternal) {
      throw new InvalidTransactionStateError(
        "Referência interna deve existir se e só se houver referência externa",
      );
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = props.referenceTransactionId;
    this._balanceAfter = props.balanceAfter;
    this._processedAt = props.at;
  }

  markPendingReference(): void {
    this.assertCanMoveTo(WagerTransactionStatus.PendingReference);
    if (this.referenceExternalTransactionId === undefined) {
      throw new InvalidTransactionStateError(
        "Sem referência externa não há o que esperar",
      );
    }
    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode, props: RejectProps): void {
    this.assertCanMoveTo(WagerTransactionStatus.Rejected);
    if (code === FailureCode.ProcessingFailed) {
      throw new InvalidTransactionStateError(
        "PROCESSING_FAILED é exclusivo do FAILED (D14.1)",
      );
    }
    const isScope = code === FailureCode.ReferenceScopeMismatch;
    if (isScope !== (props.detail !== undefined)) {
      throw new InvalidTransactionStateError(
        "detail vem só e sempre com REFERENCE_SCOPE_MISMATCH (D14.3)",
      );
    }
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._failureDetail = props.detail;
    this._balanceAfter = props.balanceAfter;
  }

  fail(code: FailureCode): void {
    this.assertCanMoveTo(WagerTransactionStatus.Failed);
    if (code !== FailureCode.ProcessingFailed) {
      throw new InvalidTransactionStateError(
        "FAILED só usa PROCESSING_FAILED (D14.1)",
      );
    }
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  // ---- consultas de domínio (R-06-35)

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return isReversal(this.kind);
  }

  /** Mesma key com hash diferente é conflito, não replay (R-06-39, D3.3). */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash !== undefined && this.payloadHash === payloadHash;
  }

  /** `ROLLBACK` é o inverso da referência (R-07-05). */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidTransactionStateError(
            "ROLLBACK precisa da referência para ter direção",
          );
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError("LOSS não move saldo");
    }
  }

  private assertCanMoveTo(next: WagerTransactionStatus): void {
    if (!TRANSITIONS[this._status].has(next)) {
      throw new InvalidTransactionStateError(
        `Transição inválida: ${this._status} → ${next}`,
      );
    }
  }
}

function isReversal(kind: WagerTransactionKind): boolean {
  return (
    kind === WagerTransactionKind.Refund ||
    kind === WagerTransactionKind.Rollback
  );
}

import {
  ConflictError,
  NotFoundError,
  TransientError,
  ValidationError,
} from "../../../shared/errors/app-errors";

/** `409 WALLET_ALREADY_EXISTS`, com o id da wallet que já existe (D6.3). */
export class WalletAlreadyExistsError extends ConflictError {
  constructor(readonly walletId: string) {
    super("WALLET_ALREADY_EXISTS", "Já existe wallet para este playerId e moeda", {
      walletId,
    });
  }
}

/** O banco recusou a wallet pelo `UNIQUE (player_id, currency)`: outro pedido ganhou. */
export class DuplicateWalletError extends Error {
  constructor() {
    super("wallets_player_currency_uq");
    this.name = "DuplicateWalletError";
  }
}

/** `409 IDEMPOTENCY_KEY_CONFLICT`: mesma key, payload diferente (R-09-16, D17.2). */
export class IdempotencyKeyConflictError extends ConflictError {
  constructor(readonly transactionId: string) {
    super("IDEMPOTENCY_KEY_CONFLICT", "Idempotency-Key já usada com outro payload", {
      transactionId,
    });
  }
}

/** `409 EXTERNAL_ID_CONFLICT`: o id externo já existe com outra key (D3.2, D17.2). */
export class ExternalIdConflictError extends ConflictError {
  constructor(readonly transactionId: string) {
    super("EXTERNAL_ID_CONFLICT", "externalTransactionId já usado com outra Idempotency-Key", {
      transactionId,
    });
  }
}

/**
 * Mesmo `messageId` com outro conteúdo (D3.8): bug do produtor. Na fila é
 * permanente e vai para a DLQ, que guarda a evidência (D19.4).
 */
export class InboxConflictError extends ConflictError {
  constructor() {
    super("INBOX_MESSAGE_CONFLICT", "messageId já processado com outro conteúdo");
  }
}

/**
 * O banco recusou a transação por um `UNIQUE` de key ou de id externo:
 * outra submissão ganhou fora do lock desta wallet (D3.6). O use case
 * repete uma vez e cai no replay ou no `409`.
 */
export class DuplicateTransactionError extends Error {
  constructor(readonly constraint: string) {
    super(constraint);
    this.name = "DuplicateTransactionError";
  }
}

/**
 * A repetição da D3.6 bateu de novo num `UNIQUE` de key ou de id externo:
 * conflito transitório, `503` + `Retry-After` (D17.6). Reenviar com a
 * mesma key cai no replay ou no `409`.
 */
export class ConcurrentSubmissionError extends TransientError {
  constructor() {
    super("Submissão concorrente com a mesma identidade; tente de novo");
  }
}

/** Submissão que o domínio recusa só pelo payload (D5): `400`, nada gravado. */
export class InvalidSubmissionError extends ValidationError {
  constructor(reason: string) {
    super("corpo inválido", { issues: [{ path: "", message: reason }] });
  }
}

export class TransactionNotFoundError extends NotFoundError {
  constructor() {
    super("Transação");
  }
}

export class WalletNotFoundError extends NotFoundError {
  constructor() {
    super("Wallet");
  }
}

/** Cursor do ledger que não foi emitido por nós (D6.8): `400`. */
export class InvalidCursorError extends ValidationError {
  constructor() {
    super("cursor inválido", { issues: [{ path: "cursor", message: "cursor inválido" }] });
  }
}

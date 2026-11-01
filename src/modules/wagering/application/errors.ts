import {
  ConflictError,
  NotFoundError,
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

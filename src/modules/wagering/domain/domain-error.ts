/**
 * Erros do domínio. Todos indicam payload inválido ou erro de programação:
 * violações de regra de negócio não lançam, viram `REJECTED` com
 * `failureCode` (D5).
 */
export abstract class DomainError extends Error {
  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Valor ou moeda fora do formato de entrada (R-06-14, D2.1, D2.2). */
export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super(message);
  }
}

/** Operação entre moedas diferentes (R-06-13). */
export class CurrencyMismatchError extends DomainError {
  constructor(expected: string, received: string) {
    super(`Moeda ${received} incompatível com ${expected}`);
  }
}

/** Transição a partir de um estado que não a permite (R-06-34, D4.5). */
export class InvalidTransactionStateError extends DomainError {
  constructor(message: string) {
    super(message);
  }
}

export type InvalidWagerTransactionReason =
  | "OPENING_NOT_SUBMITTABLE"
  | "REFERENCE_REQUIRED"
  | "REFERENCE_FORBIDDEN"
  | "AMOUNT_MUST_BE_POSITIVE"
  | "AMOUNT_MUST_NOT_BE_NEGATIVE";

/** Submissão decidível como inválida só pelo payload (D5: 400). */
export class InvalidWagerTransactionError extends DomainError {
  constructor(readonly reason: InvalidWagerTransactionReason) {
    super(`Transação inválida: ${reason}`);
  }
}

/** Movimento que a wallet nunca deveria receber (erro de programação). */
export class InvalidWalletOperationError extends DomainError {
  constructor(message: string) {
    super(message);
  }
}

/** Débito que deixaria o saldo negativo (R-06-23). */
export class InsufficientFundsError extends DomainError {
  constructor() {
    super("Saldo insuficiente");
  }
}

/** Crédito que passaria do teto de saldo (D2.4). */
export class BalanceLimitExceededError extends DomainError {
  constructor() {
    super("Saldo passaria do teto");
  }
}

/** Lançamento com aritmética ou campos inválidos (R-06-41). */
export class InvalidLedgerEntryError extends DomainError {
  constructor(message: string) {
    super(message);
  }
}

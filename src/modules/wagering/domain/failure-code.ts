/**
 * Taxonomia de falhas (D5, D14.1). O que o provedor deve fazer com cada
 * código está no README do domínio.
 */
export enum FailureCode {
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  InsufficientFundsForReversal = "INSUFFICIENT_FUNDS_FOR_REVERSAL",
  CurrencyMismatch = "CURRENCY_MISMATCH",
  WalletPlayerMismatch = "WALLET_PLAYER_MISMATCH",
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  ReferenceScopeMismatch = "REFERENCE_SCOPE_MISMATCH",
  ReferenceKindNotAllowed = "REFERENCE_KIND_NOT_ALLOWED",
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
  AmountMismatch = "AMOUNT_MISMATCH",
  BalanceLimitExceeded = "BALANCE_LIMIT_EXCEEDED",
  /** Único código do `FAILED` (D14.1). */
  ProcessingFailed = "PROCESSING_FAILED",
}

export const FAILURE_CODES: readonly FailureCode[] = Object.values(FailureCode);

/** Campo divergente de um `REFERENCE_SCOPE_MISMATCH` (D14.3). */
export enum ReferenceScopeField {
  Player = "PLAYER",
  Wallet = "WALLET",
  Currency = "CURRENCY",
  Round = "ROUND",
}

export const REFERENCE_SCOPE_FIELDS: readonly ReferenceScopeField[] =
  Object.values(ReferenceScopeField);

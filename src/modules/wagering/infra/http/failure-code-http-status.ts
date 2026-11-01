import { HttpStatus } from "@nestjs/common";
import { FailureCode } from "../../domain/failure-code";

/**
 * Status HTTP de cada `failureCode` (D5, D16.4). Rejeição por regra de
 * negócio → `422`; `PROCESSING_FAILED` (o `FAILED`, erro permanente de
 * infraestrutura) → `500`. O `Record` obriga a cobrir todo código novo.
 */
export const FAILURE_CODE_HTTP_STATUS: Readonly<Record<FailureCode, HttpStatus>> =
  {
    [FailureCode.InsufficientFunds]: HttpStatus.UNPROCESSABLE_ENTITY,
    [FailureCode.InsufficientFundsForReversal]: HttpStatus.UNPROCESSABLE_ENTITY,
    [FailureCode.CurrencyMismatch]: HttpStatus.UNPROCESSABLE_ENTITY,
    [FailureCode.WalletPlayerMismatch]: HttpStatus.UNPROCESSABLE_ENTITY,
    [FailureCode.ReferenceNotFound]: HttpStatus.UNPROCESSABLE_ENTITY,
    [FailureCode.ReferenceScopeMismatch]: HttpStatus.UNPROCESSABLE_ENTITY,
    [FailureCode.ReferenceKindNotAllowed]: HttpStatus.UNPROCESSABLE_ENTITY,
    [FailureCode.ReferenceNotProcessed]: HttpStatus.UNPROCESSABLE_ENTITY,
    [FailureCode.ReferenceAlreadyReversed]: HttpStatus.UNPROCESSABLE_ENTITY,
    [FailureCode.AmountMismatch]: HttpStatus.UNPROCESSABLE_ENTITY,
    [FailureCode.BalanceLimitExceeded]: HttpStatus.UNPROCESSABLE_ENTITY,
    [FailureCode.ProcessingFailed]: HttpStatus.INTERNAL_SERVER_ERROR,
  };

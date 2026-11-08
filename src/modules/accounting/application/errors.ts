import { ConflictError, ValidationError } from "../../../shared/errors/app-errors";

/**
 * Evento que nunca vira lançamento (D27.5): par incoerente, `kind` e
 * direção sem lançamento, moeda diferente da conta. Permanente → DLQ. A
 * mensagem não leva valores (D11.1).
 */
export class AccountingEventRejectedError extends ValidationError {
  constructor(reason: string) {
    super(`evento sem lançamento possível: ${reason}`);
  }
}

/**
 * Mesmo `eventId` com outro conteúdo, ou outra metade do mesmo tipo para a
 * transação (D3.8, D27.4): bug do produtor. Permanente → DLQ.
 */
export class AccountingEventConflictError extends ConflictError {
  constructor(message: string) {
    super("INBOX_MESSAGE_CONFLICT", message);
  }
}

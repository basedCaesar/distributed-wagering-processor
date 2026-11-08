/**
 * Erros do domínio do accounting. Todos indicam um evento que nunca vai
 * virar lançamento (permanente, D27.5): a aplicação os traduz para a
 * categoria de validação.
 */
export abstract class AccountingDomainError extends Error {
  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Valor ou moeda fora do formato do `MoneyProps` (D2, D27.2). */
export class InvalidAmountError extends AccountingDomainError {
  constructor(message: string) {
    super(message);
  }
}

/** Kind e direção sem lançamento no plano de contas, ou valor zero (D27.2). */
export class InvalidPostingError extends AccountingDomainError {
  constructor(message: string) {
    super(message);
  }
}

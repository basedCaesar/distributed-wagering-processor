/**
 * Erros com categoria HTTP conhecida (D5, D16.2). A aplicação e a borda
 * estendem estas classes; o `classifyError()` não conhece módulo nenhum.
 */
export abstract class AppError extends Error {
  protected constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Decidível só pelo payload (D5): `400`, nada gravado. */
export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

/** Sem token, ou token inválido (D10.1, D16.1). */
export class UnauthenticatedError extends AppError {
  constructor(message = "Token ausente ou inválido") {
    super(message);
  }
}

/** Token válido, papel sem permissão (D10.2). */
export class ForbiddenError extends AppError {
  constructor(message = "Sem permissão para esta operação") {
    super(message);
  }
}

/** Recurso inexistente, ou de outro provedor (D5, D10.2). */
export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(`${resource} não encontrado`);
  }
}

/** Conflito com código próprio (D5, D16.2): `WALLET_ALREADY_EXISTS`, ... */
export class ConflictError extends AppError {
  constructor(
    readonly code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message, details);
  }
}

/** Falha transitória de infraestrutura (D5): `503` + `Retry-After`. */
export class TransientError extends AppError {
  constructor(message: string) {
    super(message);
  }
}

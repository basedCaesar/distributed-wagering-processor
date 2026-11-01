import { ConnectionException } from "@mikro-orm/core";
import { HttpException, HttpStatus } from "@nestjs/common";
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  TransientError,
  UnauthenticatedError,
  ValidationError,
} from "./app-errors";

export type ErrorCategory =
  | "validation"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "transient"
  | "internal";

export interface ClassifiedError {
  category: ErrorCategory;
  httpStatus: HttpStatus;
  /** Código do corpo de erro (D16.2). */
  code: string;
  /** Mensagem segura para o cliente: a de um erro interno nunca vaza. */
  message: string;
  details?: Record<string, unknown>;
}

/**
 * SQLSTATE e códigos de socket transitórios (D5): timeout de lock e de
 * comando, deadlock, conexão perdida ou recusada, servidor desligando.
 * Um retry pode dar certo; o provedor recebe `503`.
 */
const TRANSIENT_SQLSTATES = new Set(["55P03", "57014", "40P01", "40001"]);
const TRANSIENT_SQLSTATE_CLASSES = ["08", "53", "57P"];
const TRANSIENT_SOCKET_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

const BY_CATEGORY: Record<
  Exclude<ErrorCategory, "conflict">,
  { httpStatus: HttpStatus; code: string }
> = {
  validation: { httpStatus: HttpStatus.BAD_REQUEST, code: "VALIDATION_ERROR" },
  unauthenticated: {
    httpStatus: HttpStatus.UNAUTHORIZED,
    code: "UNAUTHENTICATED",
  },
  forbidden: { httpStatus: HttpStatus.FORBIDDEN, code: "FORBIDDEN" },
  not_found: { httpStatus: HttpStatus.NOT_FOUND, code: "NOT_FOUND" },
  transient: {
    httpStatus: HttpStatus.SERVICE_UNAVAILABLE,
    code: "TEMPORARILY_UNAVAILABLE",
  },
  internal: {
    httpStatus: HttpStatus.INTERNAL_SERVER_ERROR,
    code: "INTERNAL_ERROR",
  },
};

function of(
  category: Exclude<ErrorCategory, "conflict">,
  message: string,
  details?: Record<string, unknown>,
): ClassifiedError {
  return {
    category,
    ...BY_CATEGORY[category],
    message,
    ...(details !== undefined && { details }),
  };
}

function isTransientDriverError(error: unknown): boolean {
  if (error instanceof ConnectionException) return true;
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const { code } = error as { code: unknown };
  if (typeof code !== "string") return false;
  return (
    TRANSIENT_SQLSTATES.has(code) ||
    TRANSIENT_SOCKET_CODES.has(code) ||
    TRANSIENT_SQLSTATE_CLASSES.some((prefix) => code.startsWith(prefix))
  );
}

/**
 * Ponto único de classificação de erros (CLAUDE.md): todo `catch` que não
 * trata um erro específico passa por aqui. Erro de domínio, constraint sem
 * tradução ou qualquer outra coisa desconhecida é bug → `500`.
 */
export function classifyError(error: unknown): ClassifiedError {
  if (error instanceof AppError) {
    if (error instanceof ValidationError) {
      return of("validation", error.message, error.details);
    }
    if (error instanceof UnauthenticatedError) {
      return of("unauthenticated", error.message);
    }
    if (error instanceof ForbiddenError) return of("forbidden", error.message);
    if (error instanceof NotFoundError) return of("not_found", error.message);
    if (error instanceof ConflictError) {
      return {
        category: "conflict",
        httpStatus: HttpStatus.CONFLICT,
        code: error.code,
        message: error.message,
        ...(error.details !== undefined && { details: error.details }),
      };
    }
    if (error instanceof TransientError) {
      return of("transient", "Indisponível no momento; tente de novo");
    }
  }
  if (isTransientDriverError(error)) {
    return of("transient", "Indisponível no momento; tente de novo");
  }
  // Erros do próprio Nest antes do controller: rota inexistente; JSON mal
  // formado ou corpo grande demais (decidível só pelo payload, D5).
  if (error instanceof HttpException) {
    const status = error.getStatus();
    if (status === HttpStatus.NOT_FOUND) {
      return of("not_found", "Rota não encontrada");
    }
    if (status >= 400 && status < 500) {
      return of("validation", "Requisição inválida");
    }
  }
  return of("internal", "Erro interno");
}

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
  /**
   * Identificação de um erro do banco, para o log (D22.9 e): só SQLSTATE,
   * constraint e tabela. Nunca o `detail`, o `where`, os parâmetros nem a
   * query, que trazem a linha com valores e `player_id`.
   */
  db?: DbErrorFields;
}

export interface DbErrorFields {
  sqlState?: string;
  constraint?: string;
  table?: string;
}

/** SQLSTATE: 5 caracteres alfanuméricos maiúsculos. */
const SQLSTATE = /^[0-9A-Z]{5}$/;
/** Identificador do Postgres sem aspas: o que as nossas migrations criam. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

function pick(source: object, key: string, format: RegExp): string | undefined {
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" && format.test(value) ? value : undefined;
}

/**
 * Os campos de identificação de um erro do `pg` (ou do MikroORM, que os
 * copia), cada um conferido contra o formato esperado: um valor fora do
 * formato é descartado, nunca repassado. `undefined` se não houver nenhum.
 */
export function dbErrorFields(error: unknown): DbErrorFields | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const sqlState = pick(error, "code", SQLSTATE);
  const constraint = pick(error, "constraint", IDENTIFIER);
  const table = pick(error, "table", IDENTIFIER);
  if (sqlState === undefined && constraint === undefined && table === undefined) return undefined;
  return {
    ...(sqlState !== undefined && { sqlState }),
    ...(constraint !== undefined && { constraint }),
    ...(table !== undefined && { table }),
  };
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

/**
 * Mensagens exatas com que o `pg` lança `Error` **sem** `code` quando a
 * conexão cai (Postgres parado ou reiniciado com conexões abertas no pool)
 * ou não abre a tempo. Comparação exata: um `Error` qualquer com texto
 * parecido continua sendo bug (D5, D21.9).
 */
const PG_CONNECTION_LOST_MESSAGES = new Set([
  "Connection terminated unexpectedly",
  "Connection terminated",
  "Connection terminated due to connection timeout",
  "timeout exceeded when trying to connect",
  "Client has encountered a connection error and is not queryable",
]);

function isTransientDriverError(error: unknown): boolean {
  if (error instanceof ConnectionException) return true;
  if (error instanceof Error && !("code" in error) && PG_CONNECTION_LOST_MESSAGES.has(error.message)) {
    return true;
  }
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
  const classified = classify(error);
  const db = error instanceof AppError ? undefined : dbErrorFields(error);
  return db === undefined ? classified : { ...classified, db };
}

function classify(error: unknown): ClassifiedError {
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

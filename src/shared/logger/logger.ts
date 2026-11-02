import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";
import { dbErrorFields } from "../errors/classify-error";
import { getContext } from "./request-context";

/**
 * Campos que nunca saem num log (D11.1, D22.9 c), no 1º e no 2º nível:
 * valores, saldos, `playerId`, o header `Authorization`, payloads e corpos.
 * É defesa em profundidade: o código já não loga nada disso.
 */
const SENSITIVE_FIELDS = [
  "authorization",
  "playerId",
  "amount",
  "money",
  "balance",
  "balanceAfter",
  "balanceBefore",
  "initialBalance",
  "payload",
  "body",
] as const;

export const LOG_REDACT_PATHS: readonly string[] = [
  ...SENSITIVE_FIELDS.flatMap((field) => [field, `*.${field}`]),
  // O lugar comum do header num objeto de requisição (`req.headers.authorization`): 3º nível.
  "*.headers.authorization",
];

/**
 * Serializer de erro (D22.9 e): só o tipo e a identificação do banco
 * (`code`, `constraint`, `table`), conferidos contra o formato. Nunca a
 * `message` (o MikroORM põe a query nela), o `detail` ("Failing row
 * contains (...)"), o `where`, os parâmetros nem o stack.
 */
export function safeError(error: unknown): Record<string, string> {
  const type = error instanceof Error ? error.constructor.name : typeof error;
  const db = dbErrorFields(error);
  return {
    type,
    ...(db?.sqlState !== undefined && { code: db.sqlState }),
    ...(db?.constraint !== undefined && { constraint: db.constraint }),
    ...(db?.table !== undefined && { table: db.table }),
  };
}

export const LOGGER_OPTIONS: LoggerOptions = {
  // Contexto da operação em toda linha (D11.1): correlationId, messageId,
  // transactionId, walletId e providerId.
  mixin() {
    return getContext() ?? {};
  },
  redact: { paths: [...LOG_REDACT_PATHS], censor: "[REDACTED]" },
  serializers: { err: safeError, error: safeError },
  hooks: {
    // `logger.error(err)`: o pino usaria a `message` do erro como `msg`, e ela
    // pode trazer a query. O erro vai para o serializer e o `msg` fica fixo.
    logMethod(args, method) {
      const [first, ...rest] = args as unknown[];
      if (first instanceof Error) {
        const msg = typeof rest[0] === "string" ? rest[0] : "erro";
        method.apply(this, [{ err: first }, msg] as unknown as Parameters<typeof method>);
        return;
      }
      method.apply(this, args);
    },
  },
};

/** Um logger com a configuração do processo; os testes passam um destino próprio. */
export function createLogger(destination?: DestinationStream): Logger {
  return destination === undefined ? pino(LOGGER_OPTIONS) : pino(LOGGER_OPTIONS, destination);
}

export const logger = createLogger();

import { expect } from "bun:test";
import { Client, type DatabaseError } from "pg";
import type { DatabaseCredentials } from "../../src/shared/secrets/secrets-provider.port";
import { EnvSecretsProvider } from "../../src/shared/secrets/env-secrets-provider";

const secrets = new EnvSecretsProvider();

export type DbRole = "app" | "owner";

/**
 * `app` é o papel da aplicação, usado em todos os testes (CLAUDE.md).
 * `owner` só prepara o banco e prova garantias que o privilégio esconderia
 * (P2 da S2: triggers do ledger e da reconciliação).
 */
export async function credentialsFor(
  role: DbRole,
): Promise<DatabaseCredentials> {
  return role === "app"
    ? secrets.getDatabaseCredentials()
    : secrets.getMigrationDatabaseCredentials();
}

export async function connect(role: DbRole = "app"): Promise<Client> {
  const client = new Client(await credentialsFor(role));
  await client.connect();
  return client;
}

export async function withClient<T>(
  role: DbRole,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await connect(role);
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Roda `fn` numa transação; desfaz se `fn` falhar. */
export async function inTransaction<T>(
  client: Client,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query("BEGIN");
  try {
    const result = await fn();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

/** SQLSTATE do erro de privilégio: o único sem constraint para conferir. */
const INSUFFICIENT_PRIVILEGE = "42501";

/**
 * SQLSTATE: 23505 unique, 23514 check, 23503 FK, 23000 trigger, sempre com
 * a constraint que se quer provar (outra constraint é teste mal montado);
 * 42501 privilégio, sem constraint.
 */
export type ExpectedDbError =
  | { code: typeof INSUFFICIENT_PRIVILEGE }
  | { code: string; constraint: string };

export async function expectDbError(
  operation: Promise<unknown>,
  expected: ExpectedDbError,
): Promise<void> {
  const constraint = "constraint" in expected ? expected.constraint : undefined;
  if (constraint === undefined && expected.code !== INSUFFICIENT_PRIVILEGE) {
    await operation.catch(() => undefined);
    throw new Error(
      `expectDbError: o erro ${expected.code} precisa da constraint esperada`,
    );
  }
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  if (caught === undefined) {
    throw new Error(
      `esperava o erro ${expected.code} ${constraint ?? ""} do banco, mas a operação passou`,
    );
  }
  const dbError = caught as DatabaseError;
  expect({ code: dbError.code, constraint: dbError.constraint }).toEqual({
    code: expected.code,
    constraint,
  });
}

export const newId = (): string => Bun.randomUUIDv7();

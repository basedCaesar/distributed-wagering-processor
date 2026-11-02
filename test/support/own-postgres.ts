import { join } from "node:path";
import { Client } from "pg";
import { migrateUp } from "../../migrations/migrator";
import type { DatabaseCredentials } from "../../src/shared/secrets/secrets-provider.port";
import { freePort, waitFor } from "./processes";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const DB_NAME = "wagering_own";
const IMAGE = "postgres:16-alpine";

export interface OwnPostgres {
  /** Variáveis para um processo separado usar este banco (papel da app). */
  env: Record<string, string>;
  credentials(role: "app" | "owner"): DatabaseCredentials;
  stop(): Promise<void>;
  start(): Promise<void>;
  restart(): Promise<void>;
  /** Apaga o container (sempre num `finally`, D21.7). */
  destroy(): Promise<void>;
}

async function docker(...args: string[]): Promise<string> {
  const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`docker ${args[0]} falhou (${code}): ${err.trim()}`);
  return out.trim();
}

/** O Postgres aceita conexão do papel da app (estado observável, sem `sleep`). */
async function acceptsConnections(credentials: DatabaseCredentials): Promise<boolean> {
  const client = new Client({ ...credentials, connectionTimeoutMillis: 1000 });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    // Ainda subindo (recusa, reset ou "the database system is starting up").
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Um Postgres só deste teste (D21.7): `docker run` numa porta livre, com o
 * mesmo `postgres-init.sh` (papéis da D7.3) e as migrations. O F3 reinicia
 * este container, nunca o `postgres_test` compartilhado.
 */
export async function startOwnPostgres(): Promise<OwnPostgres> {
  const port = await freePort();
  const name = `wagering-own-pg-${Bun.randomUUIDv7()}`;
  const init = join(REPO_ROOT, "scripts", "postgres-init.sh");
  await docker(
    "run",
    "-d",
    "--name",
    name,
    "-p",
    `127.0.0.1:${port}:5432`,
    "-e",
    `POSTGRES_DB=${DB_NAME}`,
    "-e",
    "POSTGRES_USER=postgres",
    "-e",
    "POSTGRES_PASSWORD=postgres",
    "-e",
    "DB_OWNER_PASSWORD=wagering_owner",
    "-e",
    "DB_APP_PASSWORD=wagering_app",
    "--mount",
    `type=bind,source=${init},target=/docker-entrypoint-initdb.d/10-roles.sh,readonly`,
    IMAGE,
  );
  const base = { host: "127.0.0.1", port, database: DB_NAME };
  const credentials = (role: "app" | "owner"): DatabaseCredentials =>
    role === "app"
      ? { ...base, user: "wagering_app", password: "wagering_app" }
      : { ...base, user: "wagering_owner", password: "wagering_owner" };
  const ready = () => waitFor(() => acceptsConnections(credentials("app")), `o Postgres próprio (${name}) aceitar conexões`, 60_000);

  const own: OwnPostgres = {
    env: { DB_HOST: "127.0.0.1", DB_PORT: String(port), DB_NAME },
    credentials,
    async stop() {
      await docker("stop", name);
    },
    async start() {
      await docker("start", name);
      await ready();
    },
    async restart() {
      await docker("restart", name);
      await ready();
    },
    async destroy() {
      await docker("rm", "-f", "-v", name);
    },
  };
  try {
    await ready();
    await migrateUp(credentials("owner"));
  } catch (error) {
    await own.destroy();
    throw error;
  }
  return own;
}

import { Client } from "pg";
import { logger } from "../logger/logger";
import type { DatabaseCredentials } from "../secrets/secrets-provider.port";
import { errorMessage, type HealthCheckResult } from "./health.types";
import { withTimeout } from "./with-timeout";

export async function checkPostgres(
  credentials: DatabaseCredentials,
  timeoutMs: number,
): Promise<HealthCheckResult> {
  const client = new Client({
    host: credentials.host,
    port: credentials.port,
    database: credentials.database,
    user: credentials.user,
    password: credentials.password,
    connectionTimeoutMillis: timeoutMs,
  });

  try {
    await withTimeout(client.connect(), timeoutMs, "postgres connect");
    await withTimeout(client.query("SELECT 1"), timeoutMs, "postgres select 1");
    return { status: "ok" };
  } catch (error) {
    return { status: "error", reason: errorMessage(error) };
  } finally {
    client.end().catch((error: unknown) => {
      logger.warn(
        { check: "postgres", reason: errorMessage(error) },
        "falha ao fechar a conexão do health check",
      );
    });
  }
}

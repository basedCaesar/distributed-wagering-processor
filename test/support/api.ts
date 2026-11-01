import { Writable } from "node:stream";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import pino from "pino";
import { ApiModule } from "../../src/app/api.module";
import { configureApiApp } from "../../src/app/configure-api-app";
import { AUTH_CONFIG } from "../../src/shared/auth/auth.config";
import { LOGGER } from "../../src/shared/logger/logger.module";
import { startTestIssuer, type TestIssuer } from "./auth";

export interface TestApi {
  app: INestApplication;
  baseUrl: string;
  issuer: TestIssuer;
  /** Linhas JSON que a aplicação logou pelo `LOGGER`. */
  logs: Record<string, unknown>[];
  request(
    method: string,
    path: string,
    options?: { token?: string | null; body?: unknown; headers?: Record<string, string> },
  ): Promise<Response>;
  close(): Promise<void>;
}

/**
 * Sobe a API real (`ApiModule`, Postgres de teste, papel da app) numa porta
 * livre. Só duas coisas mudam: o emissor de token aponta para o emissor de
 * teste (D10.3), e o logger escreve numa lista para os testes lerem.
 */
export async function startTestApi(): Promise<TestApi> {
  const issuer = await startTestIssuer();
  const logs: Record<string, unknown>[] = [];
  const sink = new Writable({
    write(chunk, _encoding, done) {
      for (const line of String(chunk).split("\n")) {
        if (line.trim() !== "") logs.push(JSON.parse(line));
      }
      done();
    },
  });

  const moduleRef = await Test.createTestingModule({ imports: [ApiModule] })
    .overrideProvider(AUTH_CONFIG)
    .useValue(issuer.config)
    .overrideProvider(LOGGER)
    .useValue(pino(sink))
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApiApp(app);
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address();
  if (typeof address === "string" || address === null) {
    throw new Error("endereço HTTP inesperado em teste");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    app,
    baseUrl,
    issuer,
    logs,
    async request(method, path, options = {}) {
      const headers: Record<string, string> = { ...options.headers };
      const token =
        options.token === undefined
          ? await issuer.operatorToken()
          : options.token;
      if (token !== null) headers.authorization = `Bearer ${token}`;
      if (options.body !== undefined) headers["content-type"] = "application/json";
      return fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    },
    async close() {
      await app.close();
      await issuer.stop();
    },
  };
}

/** Corpo de erro sem transação (D5): `{ error: { code, message, details? } }`. */
export interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

export interface MoneyJson {
  amount: string;
  currency: string;
}

export interface WalletBody {
  id: string;
  playerId: string;
  balance: MoneyJson;
  version: number;
}

export const newPlayerId = (): string => `player-${Bun.randomUUIDv7()}`;

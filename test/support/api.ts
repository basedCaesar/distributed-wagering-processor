import { Writable } from "node:stream";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import pino from "pino";
import { ApiModule } from "../../src/app/api.module";
import { configureApiApp } from "../../src/app/configure-api-app";
import { AUTH_CONFIG } from "../../src/shared/auth/auth.config";
import { logger } from "../../src/shared/logger/logger";
import { type JwksBehavior, startTestIssuer, type TestIssuer } from "./auth";

export interface TestApi {
  app: INestApplication;
  baseUrl: string;
  issuer: TestIssuer;
  /** Linhas JSON que a aplicação logou (logger singleton, inclusive pelo `LOGGER`). */
  logs: Record<string, unknown>[];
  request(
    method: string,
    path: string,
    options?: { token?: string | null; body?: unknown; headers?: Record<string, string> },
  ): Promise<Response>;
  close(): Promise<void>;
}

export interface TestApiOptions {
  /** Como o JWKS do emissor de teste responde (D16.16). */
  jwks?: JwksBehavior;
  /** Provedores trocados, para forçar caminhos de erro (ex.: um `500`). */
  overrides?: { provide: unknown; useValue: unknown }[];
}

/**
 * O logger singleton escreve no stream guardado em `streamSym`, lido a cada
 * linha: trocá-lo captura tudo o que a aplicação loga, pelo `LOGGER`
 * injetado (que é o próprio singleton) ou pelo import direto.
 */
function captureSingletonLogs(sink: Writable): () => void {
  const target = logger as unknown as Record<symbol, unknown>;
  const original = target[pino.symbols.streamSym];
  target[pino.symbols.streamSym] = sink;
  return () => {
    target[pino.symbols.streamSym] = original;
  };
}

/**
 * Sobe a API real (`ApiModule`, Postgres de teste, papel da app) numa porta
 * livre. Só duas coisas mudam: o emissor de token aponta para o emissor de
 * teste (D10.3), e o logger singleton escreve numa lista para os testes
 * lerem.
 */
export async function startTestApi(options: TestApiOptions = {}): Promise<TestApi> {
  const issuer = await startTestIssuer(
    options.jwks === undefined ? {} : { jwks: options.jwks },
  );
  const logs: Record<string, unknown>[] = [];
  const sink = new Writable({
    write(chunk, _encoding, done) {
      for (const line of String(chunk).split("\n")) {
        if (line.trim() !== "") logs.push(JSON.parse(line));
      }
      done();
    },
  });
  const restoreLogs = captureSingletonLogs(sink);

  let builder = Test.createTestingModule({ imports: [ApiModule] })
    .overrideProvider(AUTH_CONFIG)
    .useValue(issuer.config);
  for (const override of options.overrides ?? []) {
    builder = builder.overrideProvider(override.provide).useValue(override.useValue);
  }
  const moduleRef = await builder.compile();
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
      restoreLogs();
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

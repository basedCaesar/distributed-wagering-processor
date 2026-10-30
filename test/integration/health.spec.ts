import { afterEach, describe, expect, it } from "bun:test";
import { createServer } from "node:net";
import { Global, Module } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { loadConfig } from "../../src/shared/config/config";
import { APP_CONFIG } from "../../src/shared/config/config.module";
import type {
  DatabaseCredentials,
  SecretsProvider,
} from "../../src/shared/secrets/secrets-provider.port";
import { SECRETS_PROVIDER } from "../../src/shared/secrets/secrets-provider.port";
import { HealthModule } from "../../src/shared/health/health.module";

// 192.0.2.1 é o bloco TEST-NET-1 (RFC 5737): reservado, nunca roteado.
// Uma conexão para lá trava até o timeout, em vez de falhar na hora (ECONNREFUSED),
// então o teste exercita de verdade o timeout de 1s do D11.3.
const UNREACHABLE_HOST = "192.0.2.1";
const UNREACHABLE_PORT = 54321;

// Porta reservada e liberada na hora: garante que nada escuta nela, então a
// conexão é recusada de imediato (em vez do timeout do caso de host não roteável).
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("endereço TCP inesperado ao reservar porta");
  }
  const { port } = address;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return port;
}

const realCredentials: DatabaseCredentials = {
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? "5433"),
  database: process.env.DB_NAME ?? "wagering_test",
  user: process.env.DB_USER ?? "wagering_app",
  password: process.env.DB_PASSWORD ?? "wagering_app",
};

function fixedSecretsProvider(
  credentials: DatabaseCredentials,
): SecretsProvider {
  return { getDatabaseCredentials: async () => credentials };
}

async function bootHealthApp(
  config: ReturnType<typeof loadConfig>,
  secretsProvider: SecretsProvider,
) {
  @Global()
  @Module({
    providers: [
      { provide: APP_CONFIG, useValue: config },
      { provide: SECRETS_PROVIDER, useValue: secretsProvider },
    ],
    exports: [APP_CONFIG, SECRETS_PROVIDER],
  })
  class TestConfigModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [TestConfigModule, HealthModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  await app.init();
  await app.listen(0);
  return app;
}

function portOf(app: INestApplication): number {
  const address = app.getHttpServer().address();
  if (typeof address === "string" || address === null) {
    throw new Error("endereço HTTP inesperado em teste");
  }
  return address.port;
}

interface ReadyResponseBody {
  ready: boolean;
  postgres: { status: string };
  sqs: { status: string };
}

async function readyBody(response: Response): Promise<ReadyResponseBody> {
  return (await response.json()) as ReadyResponseBody;
}

let runningApp: INestApplication | undefined;

afterEach(async () => {
  await runningApp?.close();
  runningApp = undefined;
});

describe("S0 R-09-20 R-09-21 R-09-22: health checks", () => {
  it("R-09-20: GET /health/live responde 200 sem token", async () => {
    const config = loadConfig();
    runningApp = await bootHealthApp(
      config,
      fixedSecretsProvider(realCredentials),
    );

    const response = await fetch(
      `http://localhost:${portOf(runningApp)}/health/live`,
    );

    expect(response.status).toBe(200);
  });

  it("R-09-21 R-09-22: GET /health/ready responde 200 sem token quando Postgres e SQS estão de pé", async () => {
    const config = loadConfig();
    runningApp = await bootHealthApp(
      config,
      fixedSecretsProvider(realCredentials),
    );

    const response = await fetch(
      `http://localhost:${portOf(runningApp)}/health/ready`,
    );
    const body = await readyBody(response);

    expect(response.status).toBe(200);
    expect(body.ready).toBe(true);
  });

  it("R-09-21 D11.3: GET /health/ready responde 503 quando o Postgres está inalcançável, dentro do timeout de 1s", async () => {
    const config = loadConfig();
    const unreachableCredentials: DatabaseCredentials = {
      ...realCredentials,
      host: UNREACHABLE_HOST,
      port: UNREACHABLE_PORT,
    };
    runningApp = await bootHealthApp(
      config,
      fixedSecretsProvider(unreachableCredentials),
    );

    const start = performance.now();
    const response = await fetch(
      `http://localhost:${portOf(runningApp)}/health/ready`,
    );
    const elapsedMs = performance.now() - start;
    const body = await readyBody(response);

    expect(response.status).toBe(503);
    expect(body.ready).toBe(false);
    expect(body.postgres.status).toBe("error");
    expect(elapsedMs).toBeLessThan(3000);
  });

  it("R-09-21 D11.3: GET /health/ready responde 503 quando o SQS está inalcançável, dentro do timeout de 1s", async () => {
    const config = loadConfig();
    const unreachableAwsConfig = {
      ...config,
      aws: {
        ...config.aws,
        endpoint: `http://${UNREACHABLE_HOST}:${UNREACHABLE_PORT}`,
      },
    };
    runningApp = await bootHealthApp(
      unreachableAwsConfig,
      fixedSecretsProvider(realCredentials),
    );

    const start = performance.now();
    const response = await fetch(
      `http://localhost:${portOf(runningApp)}/health/ready`,
    );
    const elapsedMs = performance.now() - start;
    const body = await readyBody(response);

    expect(response.status).toBe(503);
    expect(body.ready).toBe(false);
    expect(body.sqs.status).toBe("error");
    expect(elapsedMs).toBeLessThan(3000);
  });

  it("R-09-21 D11.3: GET /health/ready responde 503 quando a porta do Postgres não tem serviço (conexão recusada)", async () => {
    const config = loadConfig();
    const refusedCredentials: DatabaseCredentials = {
      ...realCredentials,
      host: "127.0.0.1",
      port: await closedPort(),
    };
    runningApp = await bootHealthApp(
      config,
      fixedSecretsProvider(refusedCredentials),
    );

    const response = await fetch(
      `http://localhost:${portOf(runningApp)}/health/ready`,
    );
    const body = await readyBody(response);

    expect(response.status).toBe(503);
    expect(body.ready).toBe(false);
    expect(body.postgres.status).toBe("error");
  });

  it("R-09-21 D11.3: GET /health/ready responde 503 quando a porta do SQS não tem serviço (conexão recusada)", async () => {
    const config = loadConfig();
    const refusedAwsConfig = {
      ...config,
      aws: {
        ...config.aws,
        endpoint: `http://127.0.0.1:${await closedPort()}`,
      },
    };
    runningApp = await bootHealthApp(
      refusedAwsConfig,
      fixedSecretsProvider(realCredentials),
    );

    const response = await fetch(
      `http://localhost:${portOf(runningApp)}/health/ready`,
    );
    const body = await readyBody(response);

    expect(response.status).toBe(503);
    expect(body.ready).toBe(false);
    expect(body.sqs.status).toBe("error");
  });
});

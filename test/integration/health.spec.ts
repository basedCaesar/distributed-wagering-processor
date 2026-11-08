import { afterAll, beforeAll, describe, expect, it } from "bun:test";
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

/**
 * D25.8: cada cenário monta o seu app Nest uma vez, no `beforeAll`; cada
 * teste mede só a requisição. Com a montagem dentro do teste, o R-09-20
 * (o 1º teste da integração) chegou a 5,23 s numa rodada lenta do `check`
 * (07/11/2026); sozinho, com a montagem, ele leva de 0,107 s a 0,116 s
 * (5 rodadas).
 */
type Scenario =
  | "real"
  | "postgresUnreachable"
  | "sqsUnreachable"
  | "postgresRefused"
  | "sqsRefused";

const apps: Partial<Record<Scenario, INestApplication>> = {};

function appFor(scenario: Scenario): INestApplication {
  const app = apps[scenario];
  if (app === undefined) throw new Error(`app do cenário ${scenario} não montado`);
  return app;
}

beforeAll(async () => {
  const config = loadConfig();
  apps.real = await bootHealthApp(config, fixedSecretsProvider(realCredentials));
  apps.postgresUnreachable = await bootHealthApp(
    config,
    fixedSecretsProvider({
      ...realCredentials,
      host: UNREACHABLE_HOST,
      port: UNREACHABLE_PORT,
    }),
  );
  apps.sqsUnreachable = await bootHealthApp(
    {
      ...config,
      aws: {
        ...config.aws,
        endpoint: `http://${UNREACHABLE_HOST}:${UNREACHABLE_PORT}`,
      },
    },
    fixedSecretsProvider(realCredentials),
  );
  apps.postgresRefused = await bootHealthApp(
    config,
    fixedSecretsProvider({
      ...realCredentials,
      host: "127.0.0.1",
      port: await closedPort(),
    }),
  );
  apps.sqsRefused = await bootHealthApp(
    {
      ...config,
      aws: {
        ...config.aws,
        endpoint: `http://127.0.0.1:${await closedPort()}`,
      },
    },
    fixedSecretsProvider(realCredentials),
  );
});

afterAll(async () => {
  for (const app of Object.values(apps)) await app?.close();
});

describe("S0 R-09-20 R-09-21 R-09-22: health checks", () => {
  it("R-09-20: GET /health/live responde 200 sem token", async () => {
    const response = await fetch(
      `http://localhost:${portOf(appFor("real"))}/health/live`,
    );

    expect(response.status).toBe(200);
  });

  it("R-09-21 R-09-22: GET /health/ready responde 200 sem token quando Postgres e SQS estão de pé", async () => {
    const response = await fetch(
      `http://localhost:${portOf(appFor("real"))}/health/ready`,
    );
    const body = await readyBody(response);

    expect(response.status).toBe(200);
    expect(body.ready).toBe(true);
  });

  it("R-09-21 D11.3: GET /health/ready responde 503 quando o Postgres está inalcançável, dentro do timeout de 1s", async () => {
    const start = performance.now();
    const response = await fetch(
      `http://localhost:${portOf(appFor("postgresUnreachable"))}/health/ready`,
    );
    const elapsedMs = performance.now() - start;
    const body = await readyBody(response);

    expect(response.status).toBe(503);
    expect(body.ready).toBe(false);
    expect(body.postgres.status).toBe("error");
    expect(elapsedMs).toBeLessThan(3000);
  });

  it("R-09-21 D11.3: GET /health/ready responde 503 quando o SQS está inalcançável, dentro do timeout de 1s", async () => {
    const start = performance.now();
    const response = await fetch(
      `http://localhost:${portOf(appFor("sqsUnreachable"))}/health/ready`,
    );
    const elapsedMs = performance.now() - start;
    const body = await readyBody(response);

    expect(response.status).toBe(503);
    expect(body.ready).toBe(false);
    expect(body.sqs.status).toBe("error");
    expect(elapsedMs).toBeLessThan(3000);
  });

  it("R-09-21 D11.3: GET /health/ready responde 503 quando a porta do Postgres não tem serviço (conexão recusada)", async () => {
    const response = await fetch(
      `http://localhost:${portOf(appFor("postgresRefused"))}/health/ready`,
    );
    const body = await readyBody(response);

    expect(response.status).toBe(503);
    expect(body.ready).toBe(false);
    expect(body.postgres.status).toBe("error");
  });

  it("R-09-21 D11.3: GET /health/ready responde 503 quando a porta do SQS não tem serviço (conexão recusada)", async () => {
    const response = await fetch(
      `http://localhost:${portOf(appFor("sqsRefused"))}/health/ready`,
    );
    const body = await readyBody(response);

    expect(response.status).toBe(503);
    expect(body.ready).toBe(false);
    expect(body.sqs.status).toBe("error");
  });
});

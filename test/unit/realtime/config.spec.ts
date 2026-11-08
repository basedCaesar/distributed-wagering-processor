import { describe, expect, it } from "bun:test";
import { instanceQueueName, loadRealtimeConfig } from "../../../src/modules/realtime/infra/realtime-config";

const base = {
  AWS_REGION: "us-east-1",
  AWS_ENDPOINT: "http://localstack:4566",
  AUTH_ISSUER: "http://localhost:8080/realms/wagering",
  AUTH_AUDIENCE: "wagering-api",
  AUTH_JWKS_URL: "http://keycloak:8080/realms/wagering/protocol/openid-connect/certs",
  REALTIME_INSTANCE_ID: "realtime-1",
};

describe("D28.5 D28.11: config própria do realtime", () => {
  it("D28.11: valores padrão (porta 3001, 5 s de auth, 50 wallets, ping de 30 s)", () => {
    const config = loadRealtimeConfig(base);

    expect(config).toMatchObject({
      instanceId: "realtime-1",
      port: 3001,
      aws: { region: "us-east-1", endpoint: "http://localstack:4566" },
      authTimeoutMs: 5000,
      maxFollowsPerConnection: 50,
      pingIntervalMs: 30_000,
      receiveWaitSeconds: 20,
      metricsPort: 9464,
    });
    expect(config.auth).toMatchObject({ issuer: base.AUTH_ISSUER, audience: "wagering-api" });
  });

  it("D28.5 D28.11: não exige banco, as filas do núcleo nem o tópico (a assinatura é da infra)", () => {
    expect(() => loadRealtimeConfig(base)).not.toThrow();
  });

  it.each([
    ["sem id", { REALTIME_INSTANCE_ID: undefined }],
    ["id com maiúscula", { REALTIME_INSTANCE_ID: "Realtime-1" }],
    ["id com ponto", { REALTIME_INSTANCE_ID: "realtime.1" }],
    ["id longo demais", { REALTIME_INSTANCE_ID: `r${"x".repeat(40)}` }],
    ["sem endpoint da AWS", { AWS_ENDPOINT: undefined }],
    ["sem emissor", { AUTH_ISSUER: undefined }],
  ])("D28.5 D10.3: %s → falha na subida", (_, overrides) => {
    expect(() => loadRealtimeConfig({ ...base, ...overrides })).toThrow();
  });

  it("D28.5: a fila da instância vem do id estável", () => {
    expect(instanceQueueName("realtime-1")).toBe("wagering-events-realtime-realtime-1.fifo");
    // Limite do SQS: 80 caracteres com o `.fifo`.
    expect(instanceQueueName(`r${"x".repeat(39)}`).length).toBeLessThanOrEqual(80);
  });
});

import { describe, expect, it } from "bun:test";
import {
  EnvSecretsProvider,
  MissingSecretError,
} from "../../src/shared/secrets/env-secrets-provider";

const baseEnv = {
  DB_HOST: "localhost",
  DB_PORT: "5432",
  DB_NAME: "wagering",
  DB_USER: "wagering_app",
  DB_PASSWORD: "secret",
};

describe("S0 D12.3: SecretsProvider de variável de ambiente", () => {
  it("D12.3: lê as credenciais do banco das variáveis de ambiente", async () => {
    const provider = new EnvSecretsProvider(baseEnv);

    const credentials = await provider.getDatabaseCredentials();

    expect(credentials).toEqual({
      host: "localhost",
      port: 5432,
      database: "wagering",
      user: "wagering_app",
      password: "secret",
    });
  });

  it("D12.3: lança MissingSecretError quando uma variável de credencial está ausente", async () => {
    const { DB_PASSWORD, ...withoutPassword } = baseEnv;
    const provider = new EnvSecretsProvider(withoutPassword);

    await expect(provider.getDatabaseCredentials()).rejects.toThrow(
      MissingSecretError,
    );
  });
});

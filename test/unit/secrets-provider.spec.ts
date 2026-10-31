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

describe("S2 D7.3 D12.3: credenciais do papel dono, só para as migrations", () => {
  const migrationEnv = {
    ...baseEnv,
    DB_MIGRATION_USER: "wagering_owner",
    DB_MIGRATION_PASSWORD: "owner-secret",
  };

  it("D7.3: lê usuário e senha do dono, com host, porta e banco da aplicação", async () => {
    const provider = new EnvSecretsProvider(migrationEnv);

    const credentials = await provider.getMigrationDatabaseCredentials();

    expect(credentials).toEqual({
      host: "localhost",
      port: 5432,
      database: "wagering",
      user: "wagering_owner",
      password: "owner-secret",
    });
  });

  it("D7.3: sem DB_MIGRATION_USER lança MissingSecretError (não cai no papel da app)", async () => {
    const { DB_MIGRATION_USER, ...withoutOwner } = migrationEnv;
    const provider = new EnvSecretsProvider(withoutOwner);

    await expect(provider.getMigrationDatabaseCredentials()).rejects.toThrow(
      MissingSecretError,
    );
  });
});

import type {
  DatabaseCredentials,
  SecretsProvider,
} from "./secrets-provider.port";

export class MissingSecretError extends Error {
  constructor(variableName: string) {
    super(`Variável de ambiente ausente: ${variableName}`);
    this.name = "MissingSecretError";
  }
}

function requireEnv(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[name];
  if (!value) {
    throw new MissingSecretError(name);
  }
  return value;
}

export class EnvSecretsProvider implements SecretsProvider {
  constructor(
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  async getDatabaseCredentials(): Promise<DatabaseCredentials> {
    return {
      host: requireEnv(this.env, "DB_HOST"),
      port: Number.parseInt(requireEnv(this.env, "DB_PORT"), 10),
      database: requireEnv(this.env, "DB_NAME"),
      user: requireEnv(this.env, "DB_USER"),
      password: requireEnv(this.env, "DB_PASSWORD"),
    };
  }
}

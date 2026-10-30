export interface DatabaseCredentials {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface SecretsProvider {
  getDatabaseCredentials(): Promise<DatabaseCredentials>;
}

export const SECRETS_PROVIDER = Symbol("SECRETS_PROVIDER");

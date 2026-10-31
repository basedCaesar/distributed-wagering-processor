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

/**
 * Credenciais do papel dono (D7.3): só as migrations as usam. Porta
 * separada para a aplicação nunca receber o dono por injeção.
 */
export interface MigrationSecretsProvider {
  getMigrationDatabaseCredentials(): Promise<DatabaseCredentials>;
}

export const SECRETS_PROVIDER = Symbol("SECRETS_PROVIDER");

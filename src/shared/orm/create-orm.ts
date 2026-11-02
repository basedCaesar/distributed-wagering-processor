import {
  type EntitySchema,
  MikroORM,
  type Options,
} from "@mikro-orm/postgresql";
import type { DatabaseCredentials } from "../secrets/secrets-provider.port";
import { sessionOptions } from "./db-session";

export interface CreateOrmOptions {
  credentials: DatabaseCredentials;
  entities: EntitySchema[];
  /** Extras de config (ex.: o Migrator, só nas migrations). */
  overrides?: Partial<Options>;
  /** `application_name` das conexões (D21.1). */
  applicationName?: string;
}

/**
 * MikroORM sobre o `pg` (D7.1). As entidades são `EntitySchema` de records
 * planos; o domínio não conhece o ORM. Sem `version: true` em nenhum
 * schema: a `version` da wallet sobe só no domínio (D7.2).
 */
export async function createOrm(options: CreateOrmOptions): Promise<MikroORM> {
  const { credentials } = options;
  return MikroORM.init({
    host: credentials.host,
    port: credentials.port,
    dbName: credentials.database,
    user: credentials.user,
    password: credentials.password,
    entities: options.entities,
    driverOptions: { options: sessionOptions(options.applicationName) },
    discovery: { warnWhenNoEntities: false },
    ensureDatabase: false,
    allowGlobalContext: false,
    ...options.overrides,
  });
}

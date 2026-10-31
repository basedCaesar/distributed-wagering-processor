import { Migrator } from "@mikro-orm/migrations";
import type { MikroORM } from "@mikro-orm/postgresql";
import { createOrm } from "../src/shared/orm/create-orm";
import type { DatabaseCredentials } from "../src/shared/secrets/secrets-provider.port";
import { MIGRATIONS } from "./index";

/**
 * ORM só para migrations, com o papel dono (D7.3). Lista explícita, sem
 * glob nem snapshot: a ordem é a do array e o SQL é escrito à mão
 * (R-04-07: versionadas e reversíveis).
 */
export async function openMigrator(
  ownerCredentials: DatabaseCredentials,
): Promise<MikroORM> {
  return createOrm({
    credentials: ownerCredentials,
    entities: [],
    overrides: {
      extensions: [Migrator],
      migrations: {
        tableName: "mikro_orm_migrations",
        migrationsList: MIGRATIONS,
        transactional: true,
        allOrNothing: true,
        snapshot: false,
        snapshotOnMigrate: false,
      },
    },
  });
}

export async function migrateUp(owner: DatabaseCredentials): Promise<string[]> {
  return withMigrator(owner, async (orm) =>
    (await orm.migrator.up()).map((m) => m.name),
  );
}

/** Desfaz todas as migrations aplicadas. */
export async function migrateDownAll(
  owner: DatabaseCredentials,
): Promise<string[]> {
  return withMigrator(owner, async (orm) =>
    (await orm.migrator.down({ to: 0 })).map((m) => m.name),
  );
}

async function withMigrator<T>(
  owner: DatabaseCredentials,
  fn: (orm: MikroORM) => Promise<T>,
): Promise<T> {
  const orm = await openMigrator(owner);
  try {
    return await fn(orm);
  } finally {
    await orm.close();
  }
}

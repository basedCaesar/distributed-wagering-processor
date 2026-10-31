import { migrateDownAll, migrateUp } from "../migrations/migrator";
import { EnvSecretsProvider } from "../src/shared/secrets/env-secrets-provider";

// bun run scripts/migrate.ts up|down — com o papel dono (D7.3).
const direction = process.argv[2];

async function main(): Promise<void> {
  const owner =
    await new EnvSecretsProvider().getMigrationDatabaseCredentials();
  if (direction === "up") {
    const applied = await migrateUp(owner);
    console.log(
      `migrations aplicadas: ${applied.length ? applied.join(", ") : "nenhuma pendente"}`,
    );
    return;
  }
  if (direction === "down") {
    const reverted = await migrateDownAll(owner);
    console.log(
      `migrations desfeitas: ${reverted.length ? reverted.join(", ") : "nenhuma aplicada"}`,
    );
    return;
  }
  throw new Error("uso: bun run scripts/migrate.ts up|down");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

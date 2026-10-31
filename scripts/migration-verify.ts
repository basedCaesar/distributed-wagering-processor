import { Client } from "pg";
import { migrateDownAll, migrateUp } from "../migrations/migrator";
import { MIGRATIONS } from "../migrations/index";
import { EnvSecretsProvider } from "../src/shared/secrets/env-secrets-provider";
import type { DatabaseCredentials } from "../src/shared/secrets/secrets-provider.port";

// R-04-07 R-13-I1: up → down → up. O down precisa deixar o schema public
// vazio (fora a tabela de controle e os privilégios do próprio schema), e
// o segundo up precisa recriar exatamente o mesmo schema do primeiro:
// colunas, constraints, índices, triggers, funções e GRANTs.

/** Objetos da tabela de controle das migrations, que o down não apaga. */
const CONTROL = "mikro_orm_migrations%";

/**
 * Uma linha por objeto, com a definição que o próprio Postgres reconstrói
 * (`pg_get_*def`), então qualquer diferença de corpo ou de privilégio aparece.
 */
const SCHEMA_SNAPSHOT = `
  SELECT 'relation ' || c.relname || ' ' || c.relkind::text AS line
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname NOT LIKE $1
  UNION ALL
  SELECT 'column ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
         || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
         || COALESCE(' default ' || pg_get_expr(d.adbin, d.adrelid), '')
         || CASE WHEN a.attidentity <> '' THEN ' identity ' || a.attidentity::text ELSE '' END
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname NOT LIKE $1
     AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'constraint ' || c.relname || '.' || k.conname || ' ' || pg_get_constraintdef(k.oid)
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname NOT LIKE $1
  UNION ALL
  SELECT 'index ' || indexname || ' ' || indexdef
    FROM pg_indexes
   WHERE schemaname = 'public' AND tablename NOT LIKE $1
  UNION ALL
  SELECT 'trigger ' || t.tgname || ' ' || pg_get_triggerdef(t.oid)
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND NOT t.tgisinternal
  UNION ALL
  SELECT 'function ' || p.proname || ' ' || pg_get_functiondef(p.oid)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'grant ' || c.relname || ' ' || COALESCE(r.rolname, 'PUBLIC') || ' ' || g.privilege_type
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) g
    LEFT JOIN pg_roles r ON r.oid = g.grantee
   WHERE n.nspname = 'public' AND c.relname NOT LIKE $1
  UNION ALL
  SELECT 'grant ' || c.relname || '.' || a.attname || ' ' || COALESCE(r.rolname, 'PUBLIC') || ' ' || g.privilege_type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(a.attacl) g
    LEFT JOIN pg_roles r ON r.oid = g.grantee
   WHERE n.nspname = 'public' AND c.relname NOT LIKE $1
  UNION ALL
  SELECT 'schema-grant public '
         || CASE WHEN g.grantee = n.nspowner THEN 'OWNER' ELSE COALESCE(r.rolname, 'PUBLIC') END
         || ' ' || g.privilege_type
    FROM pg_namespace n
    CROSS JOIN LATERAL aclexplode(n.nspacl) g
    LEFT JOIN pg_roles r ON r.oid = g.grantee
   WHERE n.nspname = 'public'
  ORDER BY 1`;

async function snapshot(owner: DatabaseCredentials): Promise<string[]> {
  const client = new Client(owner);
  await client.connect();
  try {
    const { rows } = await client.query<{ line: string }>(SCHEMA_SNAPSHOT, [
      CONTROL,
    ]);
    return rows.map((r) => r.line);
  } finally {
    await client.end();
  }
}

/**
 * Privilégios do dono do schema, que existem antes de qualquer migration
 * (no PG 15+ o dono é `pg_database_owner`, D7.3).
 */
function isBaseline(line: string): boolean {
  return line.startsWith("schema-grant public OWNER ");
}

function difference(a: string[], b: string[]): string[] {
  const inB = new Set(b);
  return a.filter((line) => !inB.has(line));
}

async function main(): Promise<void> {
  const owner =
    await new EnvSecretsProvider().getMigrationDatabaseCredentials();

  await migrateUp(owner);
  const afterFirstUp = await snapshot(owner);

  const reverted = await migrateDownAll(owner);
  if (reverted.length !== MIGRATIONS.length) {
    throw new Error(
      `down desfez ${reverted.length} de ${MIGRATIONS.length} migrations`,
    );
  }
  const leftovers = (await snapshot(owner)).filter(
    (line) => !isBaseline(line),
  );
  if (leftovers.length > 0) {
    throw new Error(`down deixou para trás:\n${leftovers.join("\n")}`);
  }

  const reapplied = await migrateUp(owner);
  if (reapplied.length !== MIGRATIONS.length) {
    throw new Error(
      `segundo up aplicou ${reapplied.length} de ${MIGRATIONS.length}`,
    );
  }
  const afterSecondUp = await snapshot(owner);
  const missing = difference(afterFirstUp, afterSecondUp);
  const extra = difference(afterSecondUp, afterFirstUp);
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `o segundo up não recriou o mesmo schema do primeiro:\n${[
        ...missing.map((line) => `- ${line}`),
        ...extra.map((line) => `+ ${line}`),
      ].join("\n")}`,
    );
  }

  console.log(
    `migration:verify ok: ${MIGRATIONS.length} migrations, up → down → up, ${afterFirstUp.length} definições iguais`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

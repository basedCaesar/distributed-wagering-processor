/**
 * `bun run test:proofs [ids…]` (D11.4, D21.8): para cada prova de
 * `proofs/manifest.ts`,
 * 1. copia o repositório (`git ls-files`, inclusive o que ainda não foi
 *    commitado) para uma pasta temporária, com um junction do `node_modules`;
 * 2. cria o banco descartável `wagering_proof` no `postgres_test` com o
 *    superusuário do Compose de teste (só provisionamento, como o init);
 * 3. roda o teste nomeado **sem** o patch: precisa passar;
 * 4. aplica o patch (`git apply`) e roda de novo: o teste precisa **falhar**;
 * 5. num `finally`, desfaz o junction (antes de qualquer remoção), apaga o
 *    banco e apaga a cópia **sem** remoção recursiva: só se o caminho for
 *    uma cópia dentro de `<tmp>/wagering-proofs/` e não houver nenhum link
 *    lá dentro; senão aborta sem apagar nada. Nunca `git worktree remove`
 *    nem `rm -r`: foi assim que o `node_modules` do repositório foi apagado
 *    uma vez (AI_WORKFLOW, S8).
 * As migrations das provas de banco entram pelo preload dos testes
 * (`integration-setup.ts`). O log de cada execução fica em
 * `logs/proofs/<início>/`. Sai com código 1 se alguma prova não se
 * comportou como deveria.
 */
import { existsSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Client } from "pg";
import { PROOFS, type Proof } from "../proofs/manifest";

const ROOT = join(import.meta.dir, "..");
const PROOF_DB = "wagering_proof";

type TestStatus = "passed" | "failed" | "missing";

interface ProofResult {
  proof: Proof;
  base: TestStatus;
  patched: TestStatus;
  ok: boolean;
  error?: string;
}

/** `KEY=VALUE` do `.env.test`, para o host e a porta do Postgres de teste. */
async function readEnvFile(path: string): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const line of (await readFile(path, "utf8")).split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined) env[match[1]] = match[2] ?? "";
  }
  return env;
}

async function run(cmd: string[], cwd: string, env?: Record<string, string>): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn(cmd, { cwd, env: env ?? (process.env as Record<string, string>), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, output: `${out}\n${err}` };
}

/** Banco novo, com o dono e os GRANTs do `postgres-init.sh` (os papéis já existem no cluster). */
async function withSuperuser<T>(base: Record<string, string>, database: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({
    host: base.DB_HOST,
    port: Number(base.DB_PORT),
    database,
    user: process.env.PROOF_PG_SUPERUSER ?? "postgres",
    password: process.env.PROOF_PG_SUPERUSER_PASSWORD ?? "postgres",
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function createProofDb(base: Record<string, string>): Promise<void> {
  await dropProofDb(base);
  await withSuperuser(base, "postgres", (c) => c.query(`CREATE DATABASE ${PROOF_DB} OWNER wagering_owner`));
  await withSuperuser(base, PROOF_DB, async (c) => {
    await c.query(`REVOKE ALL ON DATABASE ${PROOF_DB} FROM PUBLIC`);
    await c.query(`GRANT CONNECT, TEMPORARY ON DATABASE ${PROOF_DB} TO wagering_owner`);
    await c.query(`GRANT CONNECT ON DATABASE ${PROOF_DB} TO wagering_app`);
    await c.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
  });
}

async function dropProofDb(base: Record<string, string>): Promise<void> {
  await withSuperuser(base, "postgres", (c) => c.query(`DROP DATABASE IF EXISTS ${PROOF_DB} WITH (FORCE)`));
}

/** Pasta só das cópias das provas: nada fora dela é apagado. */
const PROOFS_TMP = resolve(tmpdir(), "wagering-proofs");
const COPY_PREFIX = "copy-";

/** Pasta vazia para uma cópia, dentro de `PROOFS_TMP`. */
async function newCopyDir(): Promise<string> {
  await mkdir(PROOFS_TMP, { recursive: true });
  return mkdtemp(join(PROOFS_TMP, COPY_PREFIX));
}

/** Copia o que o git conhece (rastreado e novo, sem o ignorado) e liga o `node_modules` por junction. */
async function populateCopy(dir: string): Promise<void> {
  const { code, output } = await run(["git", "ls-files", "--cached", "--others", "--exclude-standard"], ROOT);
  if (code !== 0) throw new Error(`git ls-files falhou: ${output}`);
  for (const file of output.split("\n").map((f) => f.trim()).filter((f) => f !== "")) {
    if (!existsSync(join(ROOT, file))) continue; // apagado na árvore, ainda no índice
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await copyFile(join(ROOT, file), join(dir, file));
  }
  await symlink(join(ROOT, "node_modules"), join(dir, "node_modules"), "junction");
}

/**
 * Remove só o link, sem segui-lo (D25.7). No Windows, o junction sai com
 * `rmdir`; fora dele, o tipo `"junction"` do `symlink` vira um symlink
 * comum, e `rmdir` num symlink falha com `ENOTDIR`: lá, `unlink`.
 */
async function removeLink(path: string): Promise<void> {
  if (process.platform === "win32") await rmdir(path);
  else await unlink(path);
}

/**
 * Desfaz o junction do `node_modules` sem segui-lo (`removeLink`). Roda
 * sempre antes de qualquer remoção da cópia.
 */
async function unlinkNodeModules(dir: string): Promise<void> {
  const link = join(dir, "node_modules");
  const info = await lstat(link).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined; // a cópia quebrou antes de criar o link
    throw error;
  });
  if (info === undefined) return;
  if (!info.isSymbolicLink()) throw new Error(`${link} não é o junction esperado; nada foi apagado`);
  await removeLink(link);
  if (existsSync(link)) throw new Error(`o junction ${link} não saiu; nada foi apagado`);
}

/** O caminho é uma cópia de prova: filho direto de `PROOFS_TMP`, com o prefixo das cópias. */
function assertProofCopy(dir: string): void {
  const resolved = resolve(dir);
  const rel = relative(PROOFS_TMP, resolved);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.includes(sep) || !rel.startsWith(COPY_PREFIX)) {
    throw new Error(`${resolved} não é uma cópia de prova dentro de ${PROOFS_TMP}; nada foi apagado`);
  }
}

/** Arquivos e pastas da cópia (pastas depois do conteúdo). Algum link → aborta, sem apagar nada. */
async function entriesForRemoval(dir: string): Promise<{ files: string[]; dirs: string[] }> {
  const files: string[] = [];
  const dirs: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const name of await readdir(current)) {
      const path = join(current, name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`link encontrado na cópia (${path}); nada foi apagado`);
      if (info.isDirectory()) {
        await walk(path);
        dirs.push(path);
      } else {
        files.push(path);
      }
    }
  };
  await walk(dir);
  dirs.push(dir);
  return { files, dirs };
}

/**
 * Apaga a cópia sem remoção recursiva: confere o caminho, confere que não
 * há nenhum link lá dentro e só então remove arquivo por arquivo e pasta
 * por pasta (de dentro para fora).
 */
async function removeCopy(dir: string): Promise<void> {
  assertProofCopy(dir);
  const { files, dirs } = await entriesForRemoval(dir);
  for (const file of files) await unlink(file);
  for (const folder of dirs) await rmdir(folder);
}

function unescapeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** Estado do teste `name` no relatório JUnit do bun. */
function statusIn(junit: string, name: string): TestStatus {
  const testcase = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of junit.matchAll(testcase)) {
    const attrs = match[1] ?? "";
    const title = /\bname="([^"]*)"/.exec(attrs)?.[1];
    if (title === undefined || unescapeXml(title) !== name) continue;
    const body = match[3] ?? "";
    if (body.includes("<skipped")) return "missing";
    return body.includes("<failure") || body.includes("<error") ? "failed" : "passed";
  }
  return "missing";
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function runNamedTest(dir: string, proof: Proof, label: string, logDir: string): Promise<TestStatus> {
  const report = join(dir, `junit-${label}.xml`);
  // O ambiente do processo vence o `--env-file` (Bun): só o banco muda.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("DB_")),
  ) as Record<string, string>;
  env.DB_NAME = PROOF_DB;
  const { output } = await run(
    [
      process.execPath,
      "test",
      "--env-file=.env.test",
      "--preload",
      "./test/support/integration-setup.ts",
      "--reporter=junit",
      `--reporter-outfile=${report}`,
      proof.file,
      "-t",
      escapeRegex(proof.test),
    ],
    dir,
    env,
  );
  await writeFile(join(logDir, `${String(proof.id).padStart(2, "0")}-${label}.log`), output);
  return existsSync(report) ? statusIn(await readFile(report, "utf8"), proof.test) : "missing";
}

async function runProof(proof: Proof, base: Record<string, string>, logDir: string): Promise<ProofResult> {
  const dir = await newCopyDir();
  try {
    await populateCopy(dir);
    await createProofDb(base);
    const before = await runNamedTest(dir, proof, "base", logDir);
    const applied = await run(["git", "apply", "--whitespace=nowarn", join(ROOT, "proofs", proof.patch)], dir);
    if (applied.code !== 0) {
      return { proof, base: before, patched: "missing", ok: false, error: `git apply falhou: ${applied.output.trim()}` };
    }
    const after = await runNamedTest(dir, proof, "patched", logDir);
    return { proof, base: before, patched: after, ok: before === "passed" && after === "failed" };
  } finally {
    try {
      // Primeiro o junction, sempre: nenhuma remoção da cópia acontece com ele de pé.
      await unlinkNodeModules(dir);
    } finally {
      try {
        await dropProofDb(base);
      } finally {
        await removeCopy(dir);
      }
    }
  }
}

/** Exportados para o teste de unidade da remoção segura (`test/unit/proofs-cleanup.spec.ts`). */
export { assertProofCopy, newCopyDir, PROOFS_TMP, removeCopy, removeLink, unlinkNodeModules };

async function main(): Promise<void> {
  const wanted = new Set(process.argv.slice(2).map(Number));
  const proofs = wanted.size === 0 ? PROOFS : PROOFS.filter((p) => wanted.has(p.id));
  const base = await readEnvFile(join(ROOT, ".env.test"));
  const modulesBefore = (await readdir(join(ROOT, "node_modules"))).length;
  const startedAt = new Date().toISOString().replaceAll(":", "-").replace(/\..*$/, "");
  const logDir = join(ROOT, "logs", "proofs", startedAt);
  await mkdir(logDir, { recursive: true });

  const results: ProofResult[] = [];
  for (const proof of proofs) {
    let result: ProofResult;
    try {
      result = await runProof(proof, base, logDir);
    } catch (error) {
      result = { proof, base: "missing", patched: "missing", ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    results.push(result);
    const verdict = result.ok ? "ok  " : "FALHOU";
    console.log(
      `[${verdict}] ${String(proof.id).padStart(2)} ${proof.protection}: sem patch ${result.base}, com patch ${result.patched}${result.error ? ` (${result.error})` : ""}`,
    );
  }

  const modulesAfter = (await readdir(join(ROOT, "node_modules"))).length;
  if (modulesAfter !== modulesBefore) {
    console.error(`o node_modules do repositório mudou (${modulesBefore} → ${modulesAfter}); confira o junction`);
    process.exit(1);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} provas como esperado. Logs em ${logDir}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

if (import.meta.main) await main();

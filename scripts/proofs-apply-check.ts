/**
 * `bun run proofs:check` (dentro do `check`): confere que cada patch de
 * `proofs/` listado no manifesto ainda **aplica** na árvore atual
 * (`git apply --check`, que não muda nada). Não roda as provas: isso é o
 * `test:proofs`, lento e fora do `check` (D21.8). Assim, uma mudança de
 * código que tira o contexto de um patch aparece no `check` na hora, e não
 * quando alguém rodar as provas de novo (as provas 01 e 07 ficaram sem
 * aplicar da S9 à S11 sem ninguém ver; `AI_WORKFLOW.md`).
 *
 * Também falha se houver um `.patch` em `proofs/` fora do manifesto.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { PROOFS } from "../proofs/manifest";

const ROOT = join(import.meta.dir, "..");

async function applies(patch: string): Promise<{ ok: boolean; output: string }> {
  const child = Bun.spawn(["git", "apply", "--check", "--whitespace=nowarn", join("proofs", patch)], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { ok: exitCode === 0, output: `${stdout}${stderr}`.trim() };
}

const problems: string[] = [];

const listed = new Set(PROOFS.map((proof) => proof.patch));
const onDisk = (await readdir(join(ROOT, "proofs"))).filter((name) => name.endsWith(".patch"));
for (const name of onDisk) {
  if (!listed.has(name)) problems.push(`${name}: está em proofs/ mas não no manifesto`);
}

for (const proof of PROOFS) {
  const result = await applies(proof.patch);
  if (result.ok) {
    console.log(`[ok  ] ${String(proof.id).padStart(2)} ${proof.patch}`);
  } else {
    console.log(`[FALHOU] ${String(proof.id).padStart(2)} ${proof.patch}`);
    problems.push(`${proof.patch}: não aplica na árvore atual\n${result.output}`);
  }
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problema(s) nos patches de proofs/:\n${problems.join("\n")}`);
  console.error("Regenere o patch removendo a mesma proteção contra o código atual (D21.8).");
  process.exit(1);
}
console.log(`\n${PROOFS.length}/${PROOFS.length} patches aplicam na árvore atual.`);

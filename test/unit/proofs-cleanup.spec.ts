import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newCopyDir, PROOFS_TMP, removeCopy, removeLink, unlinkNodeModules } from "../../scripts/proofs";

/**
 * D21.8: a cópia de uma prova só é apagada se for uma cópia dentro de
 * `<tmp>/wagering-proofs/` e não tiver nenhum link; o junction do
 * `node_modules` sai antes, sem ser seguido. Filesystem real, junctions
 * de verdade (no Windows, `lstat` vê o junction como link; fora dele, o
 * junction é um symlink comum). Os links saem por `removeLink` (D25.7).
 */

/** Pasta-alvo fora da área das provas, que nunca pode ser apagada. */
async function sentinel(): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "wagering-proofs-sentinel-"));
  const file = join(dir, "keep.txt");
  await writeFile(file, "não apague");
  return { dir, file };
}

const leftovers: (() => Promise<void>)[] = [];

afterEach(async () => {
  // Limpeza manual, link por link, sem remoção recursiva.
  for (const clean of leftovers.splice(0).reverse()) await clean();
});

async function track(dir: string, files: string[] = []): Promise<void> {
  leftovers.push(async () => {
    for (const file of files) if (existsSync(file)) await unlink(file);
    if (existsSync(dir)) await rmdir(dir);
  });
}

describe("D21.8: remoção segura da cópia das provas", () => {
  it("D21.8: com o junction do node_modules desfeito antes, a cópia é apagada e o alvo do junction fica intacto", async () => {
    const target = await sentinel();
    await track(target.dir, [target.file]);
    const copy = await newCopyDir();
    await mkdir(join(copy, "src"));
    await writeFile(join(copy, "src", "a.ts"), "x");
    await symlink(target.dir, join(copy, "node_modules"), "junction");

    await unlinkNodeModules(copy);
    await removeCopy(copy);

    expect(existsSync(copy)).toBe(false);
    expect(existsSync(target.file)).toBe(true);
  });

  it("D21.8: um link qualquer dentro da cópia → aborta sem apagar nada, nem a cópia nem o alvo", async () => {
    const target = await sentinel();
    await track(target.dir, [target.file]);
    const copy = await newCopyDir();
    const inner = join(copy, "src");
    await mkdir(inner);
    await writeFile(join(inner, "a.ts"), "x");
    const link = join(inner, "escape");
    await symlink(target.dir, link, "junction");
    leftovers.push(async () => {
      if (existsSync(link)) await removeLink(link);
      if (existsSync(join(inner, "a.ts"))) await unlink(join(inner, "a.ts"));
      if (existsSync(inner)) await rmdir(inner);
      if (existsSync(copy)) await rmdir(copy);
    });

    await expect(removeCopy(copy)).rejects.toThrow("link encontrado na cópia");
    expect(existsSync(join(inner, "a.ts"))).toBe(true);
    expect(existsSync(target.file)).toBe(true);
  });

  it("D21.8: o junction ainda de pé (unlink não rodou) → removeCopy aborta, o node_modules alvo fica intacto", async () => {
    const target = await sentinel();
    await track(target.dir, [target.file]);
    const copy = await newCopyDir();
    const link = join(copy, "node_modules");
    await symlink(target.dir, link, "junction");
    leftovers.push(async () => {
      if (existsSync(link)) await removeLink(link);
      if (existsSync(copy)) await rmdir(copy);
    });

    await expect(removeCopy(copy)).rejects.toThrow("link encontrado na cópia");
    expect(existsSync(target.file)).toBe(true);
  });

  it("D21.8: caminho fora de <tmp>/wagering-proofs/ (ou sem o prefixo das cópias) → recusa, nada apagado", async () => {
    const outside = await sentinel();
    await track(outside.dir, [outside.file]);
    await expect(removeCopy(outside.dir)).rejects.toThrow("não é uma cópia de prova");
    await expect(removeCopy(PROOFS_TMP)).rejects.toThrow("não é uma cópia de prova");
    await expect(removeCopy(join(PROOFS_TMP, "copy-x", ".."))).rejects.toThrow("não é uma cópia de prova");
    expect(existsSync(outside.file)).toBe(true);
  });

  it("D21.8: node_modules que é uma pasta de verdade (não o junction) → unlinkNodeModules recusa", async () => {
    const copy = await newCopyDir();
    const modules = join(copy, "node_modules");
    await mkdir(modules);
    await track(copy);
    leftovers.push(async () => {
      if (existsSync(modules)) await rmdir(modules);
    });

    await expect(unlinkNodeModules(copy)).rejects.toThrow("não é o junction esperado");
    expect(existsSync(modules)).toBe(true);
  });
});

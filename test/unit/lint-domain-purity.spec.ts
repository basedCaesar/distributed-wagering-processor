import { describe, expect, it } from "bun:test";
import { join } from "node:path";

const projectRoot = join(import.meta.dir, "..", "..");
const fixture = join(
  "test",
  "fixtures",
  "lint",
  "domain",
  "forbidden-import.ts",
);

async function runBiomeLint(path: string) {
  const proc = Bun.spawn(["bun", "x", "biome", "lint", path], {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: stdout + stderr, exitCode };
}

describe("S0: pureza de domain/ aplicada pelo lint", () => {
  it("CLAUDE.md camadas: domain/ importando @nestjs/* falha no biome lint", async () => {
    const { stdout, exitCode } = await runBiomeLint(fixture);

    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("noRestrictedImports");
    expect(stdout).toContain("@nestjs/common");
  });
});

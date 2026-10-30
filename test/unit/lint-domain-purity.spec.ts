import { describe, expect, it } from "bun:test";
import { join } from "node:path";

const projectRoot = join(import.meta.dir, "..", "..");
const fixturesDir = join("test", "fixtures", "lint", "domain");
const fixture = join(fixturesDir, "forbidden-import.ts");
const mathFixture = join(fixturesDir, "forbidden-math.ts");

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

  it.each([
    ["forbidden-mikro-orm.ts", "@mikro-orm/core"],
    ["forbidden-aws-sdk.ts", "@aws-sdk/client-sqs"],
    ["forbidden-pino.ts", "pino"],
    ["forbidden-zod.ts", "zod"],
    ["forbidden-infra.ts", "../infra/wallet-repository"],
    ["forbidden-application.ts", "../application/submit-transaction"],
  ])(
    "CLAUDE.md camadas: domain/ importando %s (%s) falha no biome lint",
    async (file, specifier) => {
      const { stdout, exitCode } = await runBiomeLint(join(fixturesDir, file));

      expect(exitCode).not.toBe(0);
      expect(stdout).toContain("noRestrictedImports");
      expect(stdout).toContain(specifier);
    },
  );
});

/** Padrões proibidos no domain/ (D2, D14.8), inclusive por colchete e globalThis. */
const FORBIDDEN_MONEY_PATTERN =
  /\bNumber\(|\bparseFloat\b|\bparseInt\b|\bMath\s*[.[]|\.toFixed\b|\[\s*["'`](?:toFixed|Math|Number|parseFloat|parseInt)["'`]\s*\]|\bglobalThis\s*\.\s*Math\b/;

describe("S1: dinheiro sem number no domain/", () => {
  it("D2 D14.8: domain/ usando Math.* falha no biome lint", async () => {
    const { stdout, exitCode } = await runBiomeLint(mathFixture);

    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("noRestrictedGlobals");
    expect(stdout).toContain("Math");
  });

  it.each([
    "x.toFixed(2)",
    'x["toFixed"](2)',
    "x['toFixed'](2)",
    "Math.round(x)",
    'globalThis["Math"].round(x)',
    "const M = globalThis.Math",
    "Math[`round`](x)",
    "Number(x)",
    "parseInt(x, 10)",
    "parseFloat(x)",
  ])("D2 D14.8: a busca detecta %p", (line) => {
    expect(FORBIDDEN_MONEY_PATTERN.test(line)).toBe(true);
  });

  it("D2 D14.8: nenhum arquivo de src/**/domain/** usa Number(, parseFloat, parseInt, Math ou toFixed (inclusive por colchete ou globalThis)", async () => {
    const forbidden = FORBIDDEN_MONEY_PATTERN;
    const glob = new Bun.Glob("src/**/domain/**/*.ts");
    const offenders: string[] = [];
    let scanned = 0;

    for await (const path of glob.scan({ cwd: projectRoot })) {
      scanned++;
      const source = await Bun.file(join(projectRoot, path)).text();
      source.split("\n").forEach((line, index) => {
        if (forbidden.test(line)) offenders.push(`${path}:${index + 1}`);
      });
    }

    expect(scanned).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});

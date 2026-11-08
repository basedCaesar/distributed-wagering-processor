import { describe, expect, it } from "bun:test";
import { dirname, join, normalize, relative } from "node:path";

const projectRoot = join(import.meta.dir, "..", "..", "..");
const fixturesDir = join("test", "fixtures", "lint", "modules", "realtime");

/** Import (estático, dinâmico ou `require`) e o especificador. */
const IMPORT_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'`]([^"'`]+)["'`]/gm;

async function sourcesOf(pattern: string): Promise<{ path: string; source: string }[]> {
  const files: { path: string; source: string }[] = [];
  for await (const path of new Bun.Glob(pattern).scan({ cwd: projectRoot })) {
    files.push({ path: path.replaceAll("\\", "/"), source: await Bun.file(join(projectRoot, path)).text() });
  }
  return files;
}

/** Os imports relativos de um arquivo, resolvidos a partir da raiz, sem extensão. */
function resolvedImports(file: { path: string; source: string }): string[] {
  return [...file.source.matchAll(IMPORT_PATTERN)]
    .map((match) => match[1] as string)
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) =>
      relative(projectRoot, normalize(join(projectRoot, dirname(file.path), specifier)))
        .replaceAll("\\", "/")
        .replace(/\.ts$/, ""),
    );
}

async function runBiomeLint(path: string) {
  const proc = Bun.spawn(["bun", "x", "biome", "lint", path], { cwd: projectRoot, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { output: stdout + stderr, exitCode };
}

describe("D28.1 D12.2: fronteira do realtime", () => {
  it("D28.1: o realtime não importa nada do núcleo nem do accounting, nem o ORM", async () => {
    const files = [
      ...(await sourcesOf("src/modules/realtime/**/*.ts")),
      ...(await sourcesOf("src/app/realtime.module.ts")),
      ...(await sourcesOf("src/entrypoints/main-realtime.ts")),
      ...(await sourcesOf("scripts/realtime-watch.ts")),
    ];
    expect(files.length).toBeGreaterThan(3);

    const violations = files.flatMap((file) => [
      ...resolvedImports(file)
        .filter(
          (target) =>
            target.startsWith("src/modules/wagering/") ||
            target.startsWith("src/modules/accounting/") ||
            target.startsWith("src/shared/orm/"),
        )
        .map((target) => `${file.path} → ${target}`),
      ...(file.source.includes("@mikro-orm/") ? [`${file.path} → @mikro-orm`] : []),
    ]);
    expect(violations).toEqual([]);
  });

  it("D28.1 D12.2: nada do núcleo, do accounting ou do shared importa o realtime", async () => {
    const files = [
      ...(await sourcesOf("src/modules/wagering/**/*.ts")),
      ...(await sourcesOf("src/modules/accounting/**/*.ts")),
      ...(await sourcesOf("src/shared/**/*.ts")),
    ];

    const violations = files.flatMap((file) =>
      resolvedImports(file)
        .filter((target) => target.startsWith("src/modules/realtime/"))
        .map((target) => `${file.path} → ${target}`),
    );
    expect(violations).toEqual([]);
  });

  it.each([
    ["domain/forbidden-wagering-domain.ts", "../../wagering/domain/money"],
    ["domain/forbidden-infra.ts", "../infra/realtime-config"],
    ["application/forbidden-wagering-application.ts", "../../wagering/application/payload-hash"],
    ["application/forbidden-aws-sdk.ts", "@aws-sdk/client-sqs"],
    ["infra/forbidden-wagering-infra.ts", "../../wagering/infra/messaging/event-envelope.schema"],
    ["infra/forbidden-accounting.ts", "../../accounting/infra/accounting-config"],
    ["infra/forbidden-orm.ts", "../../../shared/orm/create-orm"],
  ])("D28.1: o lint recusa realtime/%s importando %s", async (file, specifier) => {
    const { output, exitCode } = await runBiomeLint(join(fixturesDir, file));

    expect(exitCode).not.toBe(0);
    expect(output).toContain("noRestrictedImports");
    expect(output).toContain(specifier);
  });
});

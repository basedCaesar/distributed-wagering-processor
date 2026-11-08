import { describe, expect, it } from "bun:test";
import { dirname, join, normalize, relative } from "node:path";

const projectRoot = join(import.meta.dir, "..", "..", "..");
const fixturesDir = join("test", "fixtures", "lint", "modules", "accounting");

/** Import (estático, dinâmico ou `require`) e o especificador. */
const IMPORT_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'`]([^"'`]+)["'`]/gm;

/** D27.8: os únicos arquivos do núcleo que o accounting importa (o laço genérico da D20.2). */
const ALLOWED_CORE_FILES = new Set([
  "src/modules/wagering/infra/messaging/sqs-consumer",
  "src/modules/wagering/infra/messaging/sqs-wager-queue",
  "src/modules/wagering/infra/messaging/consumer-policy",
  "src/modules/wagering/infra/observability/gauges",
]);

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

describe("D27.8 D12.2: fronteira entre o accounting e o núcleo", () => {
  it("D27.8: o accounting só importa do núcleo os 4 arquivos do laço genérico, e só a partir de accounting/infra", async () => {
    const files = [
      ...(await sourcesOf("src/modules/accounting/**/*.ts")),
      ...(await sourcesOf("src/app/accounting-consumer.module.ts")),
      ...(await sourcesOf("src/entrypoints/main-accounting-consumer.ts")),
    ];
    expect(files.length).toBeGreaterThan(0);

    const violations = files.flatMap((file) =>
      resolvedImports(file)
        .filter((target) => target.startsWith("src/modules/wagering/"))
        .filter((target) => !ALLOWED_CORE_FILES.has(target) || !file.path.startsWith("src/modules/accounting/infra/"))
        .map((target) => `${file.path} → ${target}`),
    );
    expect(violations).toEqual([]);
  });

  it("D27.8 D12.2: nada do núcleo importa o accounting", async () => {
    const files = [
      ...(await sourcesOf("src/modules/wagering/**/*.ts")),
      ...(await sourcesOf("src/shared/**/*.ts")),
    ];

    const violations = files.flatMap((file) =>
      resolvedImports(file)
        .filter((target) => target.startsWith("src/modules/accounting/"))
        .map((target) => `${file.path} → ${target}`),
    );
    expect(violations).toEqual([]);
  });

  it.each([
    ["domain/forbidden-wagering-domain.ts", "../../wagering/domain/money"],
    ["domain/forbidden-infra.ts", "../infra/persistence/accounting-unit-of-work"],
    ["application/forbidden-wagering-application.ts", "../../wagering/application/payload-hash"],
    ["application/forbidden-mikro-orm.ts", "@mikro-orm/postgresql"],
    ["infra/forbidden-wagering-persistence.ts", "../../wagering/infra/persistence/message-attempts"],
  ])("D27.8: o lint recusa accounting/%s importando %s", async (file, specifier) => {
    const { output, exitCode } = await runBiomeLint(join(fixturesDir, file));

    expect(exitCode).not.toBe(0);
    expect(output).toContain("noRestrictedImports");
    expect(output).toContain(specifier);
  });

  it("D27.8: o lint aceita accounting/infra importando o laço genérico (sqs-consumer, sqs-wager-queue, consumer-policy, gauges)", async () => {
    const { output, exitCode } = await runBiomeLint(join(fixturesDir, "infra", "allowed-messaging.ts"));

    expect({ exitCode, output: output.includes("noRestrictedImports") }).toEqual({ exitCode: 0, output: false });
  });
});

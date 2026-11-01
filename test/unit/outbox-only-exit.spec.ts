import { describe, expect, it } from "bun:test";
import { join } from "node:path";

const projectRoot = join(import.meta.dir, "..", "..");

/**
 * D20.10: "use case nunca publica" é estrutural. O lint proíbe `@aws-sdk/*`
 * e `infra/` em `application/`; este teste fecha o resto: nada de
 * `application/` cita o publisher, e o SNS só é tocado pelo publisher da
 * outbox. A única saída de um evento é a linha da outbox.
 */

/** Import (estático, dinâmico ou `require`) e o especificador. */
const IMPORT_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'`]([^"'`]+)["'`]/gm;

/** Especificadores que levam ao SNS ou ao publisher da outbox. */
const PUBLISHING_MODULE = /(?:^@aws-sdk\/client-sns$|\/sns-client$|\/sns-event-publisher$|\/outbox-publisher$)/;

/** Nomes do lado que publica: nenhum deles pode aparecer em `application/`. */
const PUBLISHING_NAME = /\b(?:OutboxPublisher|EventPublisher|SnsEventPublisher|PublishCommand|SNSClient|SnsSender)\b/;

/** Os únicos arquivos que podem importar o SNS ou o publisher. */
const ALLOWED_PUBLISHING_IMPORTERS = new Set([
  "src/shared/aws/sns-client.ts",
  "src/modules/wagering/infra/outbox/sns-event-publisher.ts",
  "src/modules/wagering/infra/outbox/outbox-publisher.module.ts",
  "src/modules/wagering/infra/persistence/outbox-store.ts",
  "src/entrypoints/main-outbox-publisher.ts",
]);

function importsOf(source: string): string[] {
  return [...source.matchAll(IMPORT_PATTERN)].map((match) => match[1] as string);
}

async function sourcesOf(pattern: string): Promise<{ path: string; source: string }[]> {
  const files: { path: string; source: string }[] = [];
  for await (const path of new Bun.Glob(pattern).scan({ cwd: projectRoot })) {
    files.push({ path: path.replaceAll("\\", "/"), source: await Bun.file(join(projectRoot, path)).text() });
  }
  return files;
}

describe("R-05-04 D9 D20.10: use case nunca publica; o evento só sai pela outbox", () => {
  it.each([
    ['import { SNSClient } from "@aws-sdk/client-sns";', "@aws-sdk/client-sns"],
    ['import { createSnsClient } from "../../../shared/aws/sns-client";', "../../../shared/aws/sns-client"],
    ['import type { EventPublisher } from "../infra/outbox/outbox-publisher";', "../infra/outbox/outbox-publisher"],
    ['const m = await import("../infra/outbox/sns-event-publisher");', "../infra/outbox/sns-event-publisher"],
  ])("D20.10: a busca detecta %p", (line, specifier) => {
    const found = importsOf(line);
    expect(found).toEqual([specifier]);
    expect(PUBLISHING_MODULE.test(specifier)).toBe(true);
  });

  it("D20.10: a busca não confunde o módulo Nest do publisher com o publisher", () => {
    expect(PUBLISHING_MODULE.test("../infra/outbox/outbox-publisher.module")).toBe(false);
  });

  it("D20.10: nenhum arquivo de application/ (onde estão os use cases) importa o SNS, o OutboxPublisher ou o EventPublisher, nem cita esses nomes", async () => {
    const files = await sourcesOf("src/**/application/**/*.ts");
    const offenders: string[] = [];

    for (const { path, source } of files) {
      for (const specifier of importsOf(source)) {
        if (PUBLISHING_MODULE.test(specifier)) offenders.push(`${path}: import ${specifier}`);
      }
      source.split("\n").forEach((line, index) => {
        if (PUBLISHING_NAME.test(line)) offenders.push(`${path}:${index + 1}`);
      });
    }

    expect(files.some((file) => file.path.endsWith(".use-case.ts"))).toBe(true);
    expect(offenders).toEqual([]);
  });

  it("D20.10: só o publisher da outbox (e a montagem dele) importa o SNS ou o OutboxPublisher", async () => {
    const files = await sourcesOf("src/**/*.ts");
    const importers = files
      .filter(({ source }) => importsOf(source).some((specifier) => PUBLISHING_MODULE.test(specifier)))
      .map(({ path }) => path)
      .sort();

    expect(importers.length).toBeGreaterThan(0);
    expect(importers.filter((path) => !ALLOWED_PUBLISHING_IMPORTERS.has(path))).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { accountingProcessEnv } from "../../support/accounting-process";
import { ProcessGroup } from "../../support/processes";

/**
 * D21.2 D27.6: o mesmo SIGTERM real dos 5 processos da D7.4
 * (`sigterm.spec.ts`), no `accounting-consumer`. Fora do Windows; o CI
 * conta 6 (D25.3, D27.9).
 */
const isWindows = process.platform === "win32";
/** O long poll de 20 s termina antes de sair (D19.9). */
const COMPOSE_GRACE_MS = 30_000;

let group: ProcessGroup;

beforeEach(() => {
  group = new ProcessGroup("accounting-sigterm");
});

afterEach(async () => {
  await group.close();
});

describe.skipIf(isWindows)("D8.5 D21.2 D27.6: SIGTERM real no accounting-consumer", () => {
  it("D8.5 D21.2 D27.6: accounting-consumer recebe SIGTERM → fecha o ORM (shutdown gracioso) e sai dentro dos 30 s do Compose", async () => {
    const started = await group.spawn("accounting-consumer", {
      instance: "accounting-consumer-sigterm",
      env: accountingProcessEnv(),
    });
    const begin = performance.now();
    await started.terminate();
    const elapsed = performance.now() - begin;

    expect(elapsed).toBeLessThan(COMPOSE_GRACE_MS);
    expect(started.lines.some((line) => line.includes('"msg":"conexões do banco fechadas"'))).toBe(true);
  }, COMPOSE_GRACE_MS + 30_000);
});

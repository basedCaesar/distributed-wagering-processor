import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { startTestIssuer, type TestIssuer } from "../../support/auth";
import { authEnv, type ProcessKind, ProcessGroup } from "../../support/processes";

/**
 * D21.2: no Windows, `kill("SIGTERM")` termina o processo à força, sem
 * shutdown; lá o caminho do sinal é provado pelo `app.close()`
 * (`shutdown.spec.ts` e os testes de montagem do Nest). Aqui, fora do
 * Windows, o sinal real em cada entrypoint.
 */
const isWindows = process.platform === "win32";
const KINDS: ProcessKind[] = ["api", "consumer", "outbox-publisher", "pending-worker", "event-auditor"];
/** O long poll de 20 s do consumidor e do auditor termina antes de sair (D19.9). */
const COMPOSE_GRACE_MS = 30_000;

let issuer: TestIssuer;
let group: ProcessGroup;

beforeEach(async () => {
  issuer = await startTestIssuer();
  group = new ProcessGroup("sigterm");
});

afterEach(async () => {
  await group.close();
  await issuer.stop();
});

describe.skipIf(isWindows)("D8.5 D8.6 D21.2: SIGTERM real em cada processo", () => {
  for (const kind of KINDS) {
    it(`D8.5 D8.6 D21.2: ${kind} recebe SIGTERM → fecha o ORM (shutdown gracioso) e sai dentro dos 30 s do Compose`, async () => {
      const started = await group.spawn(kind, { instance: `${kind}-sigterm`, env: authEnv(issuer) });
      const begin = performance.now();
      await started.terminate();
      const elapsed = performance.now() - begin;

      expect(elapsed).toBeLessThan(COMPOSE_GRACE_MS);
      // A última etapa do shutdown do Nest (onApplicationShutdown): só aparece se o sinal foi tratado.
      expect(started.lines.some((line) => line.includes('"msg":"conexões do banco fechadas"'))).toBe(true);
    }, COMPOSE_GRACE_MS + 30_000);
  }
});

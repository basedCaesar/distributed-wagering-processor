/**
 * `bun run test:repeat <suíte> <n>`: roda `bun run test:<suíte>` n vezes
 * seguidas (definição de pronto: concorrência verde em 10 execuções). O log
 * completo de cada rodada que falha vai para `logs/test-repeat/<início>/`
 * (a pasta `/logs` é ignorada pelo git). No fim, imprime um resumo e sai com
 * código 1 se alguma rodada falhou.
 *
 * Exemplo: `bun run test:repeat concurrency 10`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import packageJson from "../package.json";

const [suite, rawCount] = process.argv.slice(2);
const scripts = packageJson.scripts as Record<string, string>;
const script = `test:${suite}`;

if (suite === undefined || !(script in scripts)) {
  const suites = Object.keys(scripts)
    .filter((name) => name.startsWith("test:") && name !== "test:repeat")
    .map((name) => name.slice("test:".length));
  console.error(`uso: bun run test:repeat <suíte> <n>; suítes: ${suites.join(", ")}`);
  process.exit(2);
}

const count = rawCount === undefined ? Number.NaN : Number.parseInt(rawCount, 10);
if (!Number.isInteger(count) || count < 1 || String(count) !== rawCount) {
  console.error(`n precisa ser um inteiro ≥ 1; recebi ${rawCount ?? "nada"}`);
  process.exit(2);
}

const startedAt = new Date().toISOString().replaceAll(":", "-").replace(/\..*$/, "");
const logDir = join("logs", "test-repeat", `${startedAt}-${suite}`);
const failures: { run: number; exitCode: number; log: string }[] = [];
const durations: number[] = [];

for (let run = 1; run <= count; run++) {
  const begin = performance.now();
  const child = Bun.spawn(["bun", "run", script], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const seconds = (performance.now() - begin) / 1000;
  durations.push(seconds);

  if (exitCode === 0) {
    console.log(`[${run}/${count}] ok (${seconds.toFixed(1)} s)`);
    continue;
  }
  await mkdir(logDir, { recursive: true });
  const log = join(logDir, `run-${String(run).padStart(2, "0")}.log`);
  await writeFile(
    log,
    `# bun run ${script}, rodada ${run}/${count}, código ${exitCode}\n\n## stdout\n${stdout}\n## stderr\n${stderr}`,
  );
  failures.push({ run, exitCode, log });
  console.log(`[${run}/${count}] FALHOU (código ${exitCode}, ${seconds.toFixed(1)} s) → ${log}`);
}

const total = durations.reduce((sum, seconds) => sum + seconds, 0);
console.log(
  `\nResumo test:${suite}: ${count - failures.length}/${count} verdes, ${failures.length} falhas, ${total.toFixed(1)} s no total.`,
);
for (const failure of failures) {
  console.log(`  rodada ${failure.run}: código ${failure.exitCode}, log em ${failure.log}`);
}
process.exit(failures.length === 0 ? 0 : 1);

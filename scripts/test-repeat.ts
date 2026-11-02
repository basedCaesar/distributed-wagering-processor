/**
 * `bun run test:repeat <suíte> <n>`: roda `bun run test:<suíte>` n vezes
 * seguidas (definição de pronto: concorrência verde em 10 execuções). O log
 * completo de cada rodada que falha vai para `logs/test-repeat/<início>/`
 * (a pasta `/logs` é ignorada pelo git). No fim, imprime um resumo, grava-o
 * **sempre** em `logs/test-repeat/<início>/summary.md` (data, suíte,
 * rodadas, verdes) e sai com código 1 se alguma rodada falhou.
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
const summary = [
  `Resumo test:${suite}: ${count - failures.length}/${count} verdes, ${failures.length} falhas, ${total.toFixed(1)} s no total.`,
  ...failures.map((failure) => `  rodada ${failure.run}: código ${failure.exitCode}, log em ${failure.log}`),
];
console.log(`\n${summary.join("\n")}`);

// O resumo vai sempre para a pasta da execução, mesmo sem falha: é o registro de que as n rodadas rodaram.
await mkdir(logDir, { recursive: true });
const summaryFile = join(logDir, "summary.md");
await writeFile(
  summaryFile,
  [
    `# test:repeat ${suite} ${count}`,
    "",
    `- início: ${startedAt}`,
    `- suíte: test:${suite}`,
    `- rodadas: ${count}`,
    `- verdes: ${count - failures.length}`,
    `- falhas: ${failures.length}`,
    `- duração total: ${total.toFixed(1)} s`,
    "",
    "| Rodada | Resultado | Duração (s) |",
    "|---|---|---|",
    ...durations.map((seconds, i) => {
      const failure = failures.find((f) => f.run === i + 1);
      return `| ${i + 1} | ${failure ? `falhou (código ${failure.exitCode})` : "verde"} | ${seconds.toFixed(1)} |`;
    }),
    "",
  ].join("\n"),
);
console.log(`Resumo gravado em ${summaryFile}`);
process.exit(failures.length === 0 ? 0 : 1);

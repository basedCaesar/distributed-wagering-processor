import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, release, totalmem, version } from "node:os";
import { join } from "node:path";
import { evaluateRound, type RoundFacts } from "../load/lib/evaluate";
import {
  hotWalletBalance,
  LOAD_PLAN,
  parseLoadArgs,
  type RateStep,
  type ScenarioId,
  stepSeconds,
  tokenCovers,
} from "../load/lib/plan";
import { counterDelta, histogramDelta, histogramQuantile, parsePrometheus, type Scrape } from "../load/lib/prometheus";
import {
  auditorDrainRate,
  completedOperations,
  type NotQuietReason,
  notQuietReasons,
  type QueueReading,
  type QuietSample,
  summarizeHolds,
} from "../load/lib/quiesce";
import { type LoadResult, type Percentiles, type RoundResult, renderReport, type StepResult } from "../load/lib/report";
import { CONSUMER_POLICY } from "../src/modules/wagering/infra/messaging/consumer-policy";

/**
 * `bun run test:load [--rounds N]` (D26, R-14-O1): teste de carga contra o
 * Compose de dev (`bun run infra:up`), fora do `check`.
 *
 * Para cada rodada: cria as wallets pelo `POST /wallets` real; roda cada
 * passo num container do k6 na rede do Compose (D26.1), com o `/metrics`
 * interno de todos os processos lido antes e depois (D26.4); no fim, confere
 * a correção (D26.6): reconciliação de todas as wallets da rodada e consultas
 * no banco. Reprova só pela correção ou por status inesperado; latência vai
 * para o relatório (`logs/load/<execução>/report.md`, D26.7).
 */

const REPO_ROOT = join(import.meta.dir, "..");
/** Do host: criação das wallets, tokens e reconciliação (fora da medição). */
const API = "http://localhost:3000";
const KEYCLOAK = "http://localhost:8080";
/** Da rede do Compose: o k6. */
const API_IN_NETWORK = "http://nginx:80";
const SQS_IN_NETWORK = "http://localstack:4566/";
const QUEUE_URL_IN_NETWORK = "http://localstack:4566/000000000000/wager-transactions.fifo";
const DLQ_URL = "http://localhost:4566/000000000000/wager-transactions-dlq.fifo";
/** D26.13: a fila do `event-auditor`, lida antes de cada passo. */
const AUDITOR_QUEUE_URL = "http://localhost:4566/000000000000/wagering-events-auditor.fifo";
const K6_IMAGE = "grafana/k6:2.3.0";
const METRICS_PORT = 9464;
const REALM_FILE = join(REPO_ROOT, "keycloak", "realm-wagering.json");
const READY_TIMEOUT_MS = 180_000;

/** D7.4: os 11 processos da aplicação, todos com `/metrics` (D22.1). */
const APP_SERVICES = ["api-1", "api-2", "api-3", "consumer", "outbox-publisher", "pending-worker", "event-auditor"];
const EXPECTED_INSTANCES = 11;

class LoadFailure extends Error {}

interface LoadWallet {
  walletId: string;
  playerId: string;
}

// ---------------------------------------------------------------- processos

async function run(
  args: string[],
  options: { env?: Record<string, string>; stdin?: string } = {},
): Promise<{ code: number; out: string; err: string }> {
  let proc: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>;
  try {
    proc = Bun.spawn(args, {
      cwd: REPO_ROOT,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...options.env },
    });
  } catch (error) {
    throw new LoadFailure(`não consegui rodar ${args[0]}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (options.stdin !== undefined) proc.stdin.write(options.stdin);
  await proc.stdin.end();
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

async function runOk(args: string[], options: { stdin?: string } = {}): Promise<string> {
  const { code, out, err } = await run(args, options);
  if (code !== 0) throw new LoadFailure(`${args.slice(0, 3).join(" ")} saiu com ${code}: ${err.trim()}`);
  return out;
}

function parseJson<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new LoadFailure(`${what}: JSON inválido (${error instanceof Error ? error.message : String(error)})`);
  }
}

async function mapPool<T, R>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------- Compose

interface ComposeContainer {
  Name: string;
  Service: string;
  State: string;
  Networks: string;
}

/** `docker compose ps --format json`: uma linha JSON por container (ou um array, em versões antigas). */
async function devContainers(): Promise<ComposeContainer[]> {
  const out = (await runOk(["docker", "compose", "ps", "--format", "json"])).trim();
  if (out === "") return [];
  if (out.startsWith("[")) return parseJson<ComposeContainer[]>(out, "docker compose ps");
  return out.split("\n").map((line) => parseJson<ComposeContainer>(line, "docker compose ps"));
}

/** D26.8: o Compose de teste disputa CPU e distorce os números. */
async function assertTestInfraDown(): Promise<void> {
  const out = await runOk(["docker", "compose", "-f", "docker-compose.test.yml", "ps", "-q"]);
  if (out.trim() !== "") {
    throw new LoadFailure("o Compose de teste está no ar: derrube com `bun run infra:test:down` antes do test:load (D26.8)");
  }
}

interface Topology {
  network: string;
  /** `container:9464` de cada um dos 11 processos. */
  targets: string[];
  publishers: string[];
  consumers: string[];
}

async function topology(): Promise<Topology> {
  const containers = await devContainers();
  const running = containers.filter((c) => c.State === "running");
  const app = running.filter((c) => APP_SERVICES.includes(c.Service));
  if (app.length !== EXPECTED_INSTANCES) {
    throw new LoadFailure(
      `esperava ${EXPECTED_INSTANCES} processos da aplicação no Compose de dev, achei ${app.length}: suba com \`bun run infra:up\``,
    );
  }
  const nginx = running.find((c) => c.Service === "nginx");
  if (nginx === undefined) throw new LoadFailure("nginx do Compose de dev não está no ar");
  const network = nginx.Networks.split(",")[0] ?? "";
  if (network === "") throw new LoadFailure("não achei a rede do Compose de dev");
  const target = (c: ComposeContainer) => `${c.Name}:${METRICS_PORT}`;
  return {
    network,
    targets: app.map(target).sort(),
    publishers: app.filter((c) => c.Service === "outbox-publisher").map(target),
    consumers: app.filter((c) => c.Service === "consumer").map(target),
  };
}

async function waitReady(): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${API}/health/ready`)).status === 200) return;
    } catch {
      // Sem conexão ainda: o Compose está subindo.
    }
    await Bun.sleep(2000);
  }
  throw new LoadFailure(`readiness da api não ficou 200 em ${READY_TIMEOUT_MS / 1000} s`);
}

// ---------------------------------------------------------------- banco e fila

/** SQL pelo stdin do `psql`, com o papel da app (D7.3), dentro do container (como a aceitação, D23.6). */
async function sql(query: string): Promise<string> {
  const out = await runOk(
    [
      "docker",
      "compose",
      "exec",
      "-T",
      "postgres",
      "sh",
      "-c",
      'PGPASSWORD="$DB_APP_PASSWORD" psql -h 127.0.0.1 -U wagering_app -d wagering -v ON_ERROR_STOP=1 -tA -f -',
    ],
    { stdin: query },
  );
  return out.trim();
}

async function dlqDepth(): Promise<number> {
  return queueDepth(DLQ_URL);
}

async function queueDepth(url: string): Promise<number> {
  const out = await runOk([
    "docker",
    "compose",
    "exec",
    "-T",
    "localstack",
    "awslocal",
    "sqs",
    "get-queue-attributes",
    "--queue-url",
    url,
    "--attribute-names",
    "ApproximateNumberOfMessages",
    "ApproximateNumberOfMessagesNotVisible",
  ]);
  const attrs = parseJson<{ Attributes: Record<string, string> }>(out, "get-queue-attributes").Attributes;
  return Number(attrs.ApproximateNumberOfMessages ?? "0") + Number(attrs.ApproximateNumberOfMessagesNotVisible ?? "0");
}

/** Sessões da app no banco fora de `idle`, por `application_name` (a desta consulta e as do `psql` não contam). */
async function activeAppSessions(): Promise<Record<string, number>> {
  const out = await sql(
    "SELECT coalesce(json_object_agg(application_name, n), '{}'::json) FROM (" +
      "SELECT application_name, count(*) AS n FROM pg_stat_activity WHERE datname = 'wagering' " +
      "AND usename = 'wagering_app' AND pid <> pg_backend_pid() AND application_name <> 'psql' " +
      "AND state <> 'idle' GROUP BY 1) s;",
  );
  return parseJson<Record<string, number>>(out, "sessões ativas");
}

async function waitOutboxEmpty(): Promise<boolean> {
  const deadline = Date.now() + LOAD_PLAN.drainTimeoutS * 1000;
  while (Date.now() < deadline) {
    if ((await sql("SELECT count(*) FROM outbox_messages WHERE published_at IS NULL;")) === "0") return true;
    await Bun.sleep(2000);
  }
  return false;
}

// ---------------------------------------------------------------- tokens e API (fora da medição)

let tokenRequests = 0;

async function realmSecrets(): Promise<Map<string, string>> {
  const realm = parseJson<{ clients: { clientId: string; secret?: string }[] }>(
    await readFile(REALM_FILE, "utf8"),
    REALM_FILE,
  );
  return new Map(realm.clients.flatMap((c) => (c.secret === undefined ? [] : [[c.clientId, c.secret] as [string, string]])));
}

let secrets: Map<string, string> | undefined;

/** `client_credentials` no Keycloak (D10.1, D23.4). O token nunca é impresso (D11.1). */
async function token(clientId: string): Promise<{ token: string; expiresIn: number }> {
  secrets ??= await realmSecrets();
  const secret = secrets.get(clientId);
  if (secret === undefined) throw new LoadFailure(`client ${clientId} sem segredo em ${REALM_FILE}`);
  tokenRequests++;
  const res = await fetch(`${KEYCLOAK}/realms/wagering/protocol/openid-connect/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: secret }),
  });
  const body = (await res.json().catch(() => undefined)) as { access_token?: string; expires_in?: number } | undefined;
  if (res.status !== 200 || body?.access_token === undefined || body.expires_in === undefined) {
    throw new LoadFailure(`token do ${clientId}: status ${res.status}`);
  }
  return { token: body.access_token, expiresIn: body.expires_in };
}

async function createWallets(auth: string, playerIds: string[], initialBalance: string): Promise<LoadWallet[]> {
  return mapPool(playerIds, 16, async (playerId) => {
    const res = await fetch(`${API}/wallets`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ playerId, initialBalance: { amount: initialBalance, currency: "BRL" } }),
    });
    const body = (await res.json().catch(() => undefined)) as { id?: string } | undefined;
    if (res.status !== 201 || body?.id === undefined) throw new LoadFailure(`POST /wallets: status ${res.status}`);
    return { walletId: body.id, playerId };
  });
}

async function reconcileAll(auth: string, wallets: LoadWallet[]): Promise<RoundFacts["reconciliation"]> {
  const outcomes = await mapPool(wallets, 8, async (w) => {
    try {
      const res = await fetch(`${API}/wallets/${w.walletId}/reconciliation`, {
        method: "POST",
        headers: { Authorization: auth },
      });
      if (res.status !== 200) return "failed" as const;
      const body = (await res.json()) as { consistent?: boolean };
      return body.consistent === true ? ("consistent" as const) : ("inconsistent" as const);
    } catch {
      return "failed" as const;
    }
  });
  return {
    expected: wallets.length,
    consistent: outcomes.filter((o) => o === "consistent").length,
    inconsistent: wallets.filter((_, i) => outcomes[i] === "inconsistent").map((w) => w.walletId),
    failedCalls: outcomes.filter((o) => o === "failed").length,
  };
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

// ---------------------------------------------------------------- k6

interface K6Summary {
  metrics: Record<string, Record<string, number>>;
}

class Runner {
  constructor(
    readonly topo: Topology,
    readonly outDir: string,
  ) {}

  /** Um container do k6 na rede do Compose; o token vai pelo ambiente, nunca na linha de comando. */
  async k6(script: string, name: string, env: Record<string, string>, secretEnv: Record<string, string> = {}): Promise<void> {
    const args = ["docker", "run", "--rm", "--network", this.topo.network, "-v", `${this.outDir}:/out`];
    args.push("-v", `${join(REPO_ROOT, "load")}:/load:ro`);
    for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
    for (const k of Object.keys(secretEnv)) args.push("-e", k);
    args.push(K6_IMAGE, "run", "--quiet", `/load/k6/${script}`);
    const { code, out, err } = await run(args, { env: secretEnv });
    await writeFile(join(this.outDir, `${name}.k6.log`), `${out}${err}`);
    if (code !== 0) throw new LoadFailure(`k6 ${script} (${name}) saiu com ${code}; log em logs/load/.../${name}.k6.log`);
  }

  async probe(name: string): Promise<Scrape[]> {
    const file = `probe-${name}.json`;
    await this.k6("probe.ts", `probe-${name}`, { LOAD_TARGETS: this.topo.targets.join(","), LOAD_SUMMARY: `/out/${file}` });
    const raw = parseJson<Record<string, string> | null>(await readFile(join(this.outDir, file), "utf8"), file);
    if (raw === null) throw new LoadFailure(`${file}: o k6 não devolveu as leituras`);
    return this.topo.targets.map((t) => {
      const text = raw[t];
      if (text === undefined) throw new LoadFailure(`${file}: sem a leitura de ${t}`);
      return parsePrometheus(text);
    });
  }

  /**
   * D26.11: espera o repouso antes do passo, com teto, e devolve quanto
   * esperou. Estourado o teto, aborta: medir em cima do passo anterior
   * contaminaria os números.
   */
  async quiesce(name: string): Promise<{
    seconds: number;
    holds: Record<string, number>;
    auditor: { depth: number; ratePerS: number | undefined };
  }> {
    const start = Date.now();
    const auditorStart: QueueReading = { depth: await queueDepth(AUDITOR_QUEUE_URL), atMs: Date.now() };
    const auditorAt = async () => {
      const end: QueueReading = { depth: await queueDepth(AUDITOR_QUEUE_URL), atMs: Date.now() };
      return { depth: end.depth, ratePerS: auditorDrainRate(auditorStart, end) };
    };
    const deadline = start + LOAD_PLAN.quiesceTimeoutS * 1000;
    const readings: { atS: number; sample: QuietSample; reasons: NotQuietReason[] }[] = [];
    const save = () => writeFile(join(this.outDir, `quiesce-${name}.json`), JSON.stringify(readings, null, 2));
    let previous: QuietSample | undefined;
    for (let i = 1; Date.now() < deadline; i++) {
      const current: QuietSample = {
        outboxPending: Number(await sql("SELECT count(*) FROM outbox_messages WHERE published_at IS NULL;")),
        activeByProcess: await activeAppSessions(),
        completed: completedOperations(await this.probe(`quiesce-${name}-${i}`)),
      };
      const reasons = notQuietReasons(previous, current);
      readings.push({ atS: (Date.now() - start) / 1000, sample: current, reasons });
      if (reasons.length === 0) {
        await save();
        const seconds = (Date.now() - start) / 1000;
        return { seconds, holds: summarizeHolds(readings.map((r) => r.reasons)), auditor: await auditorAt() };
      }
      previous = current;
      await Bun.sleep(3000);
    }
    await save();
    throw new LoadFailure(
      `o sistema não voltou ao repouso em ${LOAD_PLAN.quiesceTimeoutS} s antes de ${name} (D26.11); leituras em quiesce-${name}.json`,
    );
  }

  async summary(name: string): Promise<K6Summary> {
    const file = `${name}.json`;
    return parseJson<K6Summary>(await readFile(join(this.outDir, file), "utf8"), file);
  }

  async walletsFile(name: string, wallets: LoadWallet[]): Promise<string> {
    await writeFile(join(this.outDir, `wallets-${name}.json`), JSON.stringify(wallets));
    return `/out/wallets-${name}.json`;
  }
}

const count = (s: K6Summary, metric: string) => s.metrics[metric]?.count ?? 0;

function percentiles(s: K6Summary, metric: string): Percentiles | undefined {
  const v = s.metrics[metric];
  if (v === undefined || (v.count ?? 0) === 0) return undefined;
  return { p50: v["p(50)"] ?? 0, p95: v["p(95)"] ?? 0, p99: v["p(99)"] ?? 0, max: v.max ?? 0 };
}

function quantiles(buckets: ReturnType<typeof histogramDelta>) {
  return {
    p50: histogramQuantile(buckets, 0.5),
    p95: histogramQuantile(buckets, 0.95),
    p99: histogramQuantile(buckets, 0.99),
  };
}

interface StepRun {
  result: StepResult;
  prefix: string;
  facts: { ops: number; resolved: number; gaveUp: number; unexpected: number; fresh: number };
}

function buildStep(
  base: Pick<StepResult, "scenario" | "label" | "targetRate" | "durationS">,
  s: K6Summary,
  before: Scrape[],
  after: Scrape[],
  throughputSeconds: number,
): StepResult {
  const conflicts = counterDelta(before, after, "wallet_lock_conflicts_total", "reason");
  const retries = counterDelta(before, after, "wagering_retries_total", "component");
  if (conflicts.resets + retries.resets > 0) {
    console.warn(`  aviso: algum processo reiniciou durante ${base.label} (contador voltou a zero)`);
  }
  const drainTimedOut = count(s, "outbox_drain_timeout") > 0;
  return {
    ...base,
    ops: count(s, "ops"),
    processed: count(s, "processed"),
    rejected: count(s, "rejected"),
    replays: count(s, "replays"),
    transientAttempts: count(s, "transient_attempts"),
    gaveUp: count(s, "gave_up"),
    unexpected: count(s, "unexpected"),
    droppedIterations: count(s, "dropped_iterations"),
    throughput: throughputSeconds > 0 ? count(s, "resolved") / throughputSeconds : 0,
    latencyMs: percentiles(s, "req_duration"),
    opLatencyMs: percentiles(s, "op_duration"),
    lockConflicts: conflicts.values,
    lockWait: quantiles(histogramDelta(before, after, "wallet_lock_wait_seconds")),
    retries: retries.values,
    outboxLag: {
      max: s.metrics.outbox_lag?.max,
      p95: s.metrics.outbox_lag?.["p(95)"],
      pendingMax: s.metrics.outbox_pending?.max,
      drainS: drainTimedOut ? undefined : s.metrics.outbox_drain_seconds?.max,
    },
  };
}

// ---------------------------------------------------------------- passos

function holdsText(holds: Record<string, number>): string {
  return Object.entries(holds)
    .sort(([, a], [, b]) => b - a)
    .map(([reason, n]) => `${reason} ×${n}`)
    .join(", ");
}

function auditorText(auditor: { depth: number; ratePerS: number | undefined }): string {
  const rate = auditor.ratePerS === undefined ? "" : `, consumindo ${auditor.ratePerS.toFixed(1)}/s`;
  return `fila do auditor: ${auditor.depth}${rate}`;
}

interface HttpStepDef {
  scenario: "warmup" | "A" | "B" | "C";
  label: string;
  prefix: string;
  name: string;
  wallets: LoadWallet[];
  step?: RateStep;
}

async function httpStep(runner: Runner, def: HttpStepDef): Promise<StepRun> {
  const durationS = def.step?.durationS ?? LOAD_PLAN.duplicates.maxDurationS;
  const quiet = await runner.quiesce(def.name);
  const provider = await token("provider-a");
  if (!tokenCovers(provider.expiresIn, stepSeconds({ durationS }))) {
    throw new LoadFailure(`o token vale ${provider.expiresIn} s, menos que o passo ${def.label} com folga (D26.3)`);
  }
  console.log(`  ${def.label}...`);
  const before = await runner.probe(`${def.name}-before`);
  await runner.k6(
    "submit.ts",
    def.name,
    {
      LOAD_SCENARIO: def.scenario,
      LOAD_PREFIX: def.prefix,
      LOAD_API: API_IN_NETWORK,
      LOAD_RATE: String(def.step?.rate ?? 0),
      LOAD_DURATION_S: String(def.step?.durationS ?? 0),
      LOAD_WALLETS_FILE: await runner.walletsFile(def.name, def.wallets),
      LOAD_PUBLISHERS: runner.topo.publishers.join(","),
      LOAD_SUMMARY: `/out/${def.name}.json`,
    },
    { LOAD_TOKEN: provider.token },
  );
  const after = await runner.probe(`${def.name}-after`);
  const s = await runner.summary(def.name);
  const elapsed = s.metrics.load_elapsed_seconds?.max ?? durationS;
  const result = buildStep(
    { scenario: def.scenario === "warmup" ? "A" : def.scenario, label: def.label, targetRate: def.step?.rate, durationS },
    s,
    before,
    after,
    def.scenario === "C" ? elapsed : durationS,
  );
  result.quiesceS = quiet.seconds;
  result.quiesceHolds = quiet.holds;
  result.auditorBacklog = quiet.auditor;
  result.processing = {
    channel: "http",
    ...quantiles(histogramDelta(before, after, "wagering_processing_duration_seconds", { channel: "http" })),
  };
  console.log(`    repouso antes: ${quiet.seconds.toFixed(1)} s (${holdsText(quiet.holds)}); ${auditorText(quiet.auditor)}`);
  console.log(
    `    ${result.ops} operações, ${result.throughput.toFixed(1)} op/s, p99 ${result.latencyMs?.p99.toFixed(1) ?? "—"} ms, ` +
      `503: ${result.transientAttempts}, inesperados: ${result.unexpected}`,
  );
  return {
    result,
    prefix: def.prefix,
    facts: {
      ops: result.ops,
      resolved: count(s, "resolved"),
      gaveUp: result.gaveUp,
      unexpected: result.unexpected,
      fresh: count(s, "fresh"),
    },
  };
}

async function queueStep(runner: Runner, prefix: string, wallets: LoadWallet[], topo: Topology): Promise<StepRun> {
  const name = "D";
  const label = `D fila ${LOAD_PLAN.queue.messages}`;
  const quiet = await runner.quiesce(name);
  console.log(
    `  ${label}... (repouso antes: ${quiet.seconds.toFixed(1)} s; ${holdsText(quiet.holds)}; ${auditorText(quiet.auditor)})`,
  );
  const before = await runner.probe(`${name}-before`);
  await runner.k6("queue.ts", name, {
    LOAD_PREFIX: prefix,
    LOAD_SQS: SQS_IN_NETWORK,
    LOAD_QUEUE_URL: QUEUE_URL_IN_NETWORK,
    LOAD_WALLETS_FILE: await runner.walletsFile(name, wallets),
    LOAD_PUBLISHERS: topo.publishers.join(","),
    LOAD_SUMMARY: `/out/${name}.json`,
  });
  const after = await runner.probe(`${name}-after`);
  const s = await runner.summary(name);
  const drainS = count(s, "queue_drain_timeout") > 0 ? undefined : s.metrics.queue_drain_seconds?.max;
  const result: StepResult = {
    ...buildStep({ scenario: "D", label, targetRate: undefined, durationS: drainS ?? 0 }, s, before, after, 0),
    queueDrainS: drainS,
    quiesceS: quiet.seconds,
    quiesceHolds: quiet.holds,
    auditorBacklog: quiet.auditor,
    processing: {
      channel: "sqs",
      ...quantiles(histogramDelta(before, after, "wagering_processing_duration_seconds", { channel: "sqs" })),
    },
  };
  if (drainS !== undefined && drainS > 0) result.throughput = result.ops / drainS;
  console.log(`    ${result.ops} mensagens, fila vazia em ${drainS?.toFixed(1) ?? "—"} s`);
  return {
    result,
    prefix,
    facts: { ops: result.ops, resolved: 0, gaveUp: 0, unexpected: result.unexpected, fresh: 0 },
  };
}

// ---------------------------------------------------------------- correção

type DbFacts = RoundFacts["db"] & {
  walletsFound: number;
  /** Transações por passo (o id externo sem o número final). */
  byPrefix: Record<string, number>;
  /** `<passo>:<status>` → transações. */
  statusByPrefix: Record<string, number>;
  queueInbox: number;
};

function dbFactsSql(prefix: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(prefix)) throw new LoadFailure(`prefixo inválido: ${prefix}`);
  const stepOf = "regexp_replace(t.external_transaction_id, '-[0-9]+$', '')";
  return `
WITH w AS (SELECT id, balance FROM wallets WHERE player_id LIKE '${prefix}-%'),
t AS (SELECT x.* FROM wager_transactions x WHERE x.wallet_id IN (SELECT id FROM w))
SELECT json_build_object(
  'walletsFound', (SELECT count(*) FROM w),
  'negativeWallets', (SELECT count(*) FROM w WHERE balance < 0),
  'balanceMismatches', (SELECT count(*) FROM w WHERE w.balance <> COALESCE((
     SELECT sum(CASE t.kind WHEN 'BET' THEN -t.amount WHEN 'LOSS' THEN 0 ELSE t.amount END)
     FROM t WHERE t.wallet_id = w.id AND t.status = 'PROCESSED'), 0)),
  'processedWithoutLedger', (SELECT count(*) FROM t WHERE t.status = 'PROCESSED' AND t.kind <> 'LOSS'
     AND NOT EXISTS (SELECT 1 FROM wallet_ledger_entries l WHERE l.transaction_id = t.id)),
  'ledgerWithoutProcessed', (SELECT count(*) FROM wallet_ledger_entries l
     JOIN wager_transactions x ON x.id = l.transaction_id
     WHERE l.wallet_id IN (SELECT id FROM w) AND x.status <> 'PROCESSED'),
  'nonTerminal', (SELECT count(*) FROM t WHERE t.status NOT IN ('PROCESSED', 'REJECTED')),
  'unexpectedKinds', (SELECT count(*) FROM t WHERE t.kind NOT IN ('OPENING', 'BET', 'WIN')),
  'unexpectedRejections', (SELECT count(*) FROM t WHERE t.status = 'REJECTED'
     AND t.failure_code IS DISTINCT FROM 'INSUFFICIENT_FUNDS'),
  'byPrefix', COALESCE((SELECT json_object_agg(p, n) FROM (
     SELECT ${stepOf} AS p, count(*) AS n FROM t WHERE t.external_transaction_id IS NOT NULL GROUP BY 1) s), '{}'::json),
  'statusByPrefix', COALESCE((SELECT json_object_agg(p || ':' || status, n) FROM (
     SELECT ${stepOf} AS p, t.status, count(*) AS n FROM t WHERE t.external_transaction_id IS NOT NULL GROUP BY 1, 2) s), '{}'::json),
  'queueInbox', (SELECT count(*) FROM inbox_messages
     WHERE consumer_name = '${CONSUMER_POLICY.consumerName}' AND message_id LIKE '${prefix}-d-%')
);`;
}

async function connectionsByProcess(): Promise<string> {
  const out = await sql(
    "SELECT coalesce(string_agg(application_name || ': ' || n, ', ' ORDER BY application_name), '') FROM " +
      "(SELECT application_name, count(*) AS n FROM pg_stat_activity WHERE datname = 'wagering' " +
      "AND application_name <> '' AND application_name <> 'psql' GROUP BY 1) s;",
  );
  return out;
}

// ---------------------------------------------------------------- rodada

async function runRound(
  runner: Runner,
  topo: Topology,
  runId: string,
  round: number,
  scenarios: ScenarioId[],
  env: Record<string, string>,
): Promise<RoundResult> {
  const prefix = `load-${runId}-r${round}`;
  const runs = (id: ScenarioId) => scenarios.includes(id);
  console.log(`\n== Rodada ${round} (${prefix}), cenários ${scenarios.join(", ")}`);
  const operator = `Bearer ${(await token("operator")).token}`;

  console.log("  criando as wallets (fora da medição)...");
  const plan = LOAD_PLAN;
  const make = (tag: string, n: number, balance: string) =>
    createWallets(
      operator,
      range(n).map((i) => `${prefix}-${tag}-${i}`),
      balance,
    );
  // As wallets do A também servem ao aquecimento, que roda sempre.
  const walletsA = await make("a", plan.throughput.wallets, plan.throughput.initialBalance);
  const walletsC = runs("C") ? await make("c", plan.duplicates.wallets, plan.duplicates.initialBalance) : [];
  const walletsD = runs("D") ? await make("d", plan.queue.wallets, plan.queue.initialBalance) : [];
  const walletsB: LoadWallet[][] = [];
  if (runs("B")) {
    for (const step of plan.hotWallet.steps) {
      walletsB.push(await make(`b${step.rate}`, 1, hotWalletBalance(step, plan.hotWallet.betAmount)));
    }
  }
  const allWallets = [...walletsA, ...walletsB.flat(), ...walletsC, ...walletsD];
  const dlqBefore = await dlqDepth();

  console.log("  aquecimento (descartado)...");
  await httpStep(runner, {
    scenario: "warmup",
    label: "aquecimento",
    prefix: `${prefix}-w`,
    name: `r${round}-warmup`,
    wallets: walletsA,
    step: plan.warmup,
  });

  const httpRuns: StepRun[] = [];
  if (runs("A")) {
    for (const step of plan.throughput.steps) {
      httpRuns.push(
        await httpStep(runner, {
          scenario: "A",
          label: `A ${step.rate}/s`,
          prefix: `${prefix}-a${step.rate}`,
          name: `r${round}-A${step.rate}`,
          wallets: walletsA,
          step,
        }),
      );
    }
    if (round === 1) env["Conexões do Postgres por processo (depois do A)"] = await connectionsByProcess();
  }
  if (runs("B")) {
    for (const [i, step] of plan.hotWallet.steps.entries()) {
      httpRuns.push(
        await httpStep(runner, {
          scenario: "B",
          label: `B ${step.rate}/s`,
          prefix: `${prefix}-b${step.rate}`,
          name: `r${round}-B${step.rate}`,
          wallets: walletsB[i] ?? [],
          step,
        }),
      );
    }
  }
  const dup = runs("C")
    ? await httpStep(runner, {
        scenario: "C",
        label: `C ${plan.duplicates.keys}×${plan.duplicates.copies}`,
        prefix: `${prefix}-c`,
        name: `r${round}-C`,
        wallets: walletsC,
      })
    : undefined;
  const queue = runs("D") ? await queueStep(runner, `${prefix}-d`, walletsD, topo) : undefined;

  console.log("  checagem de correção...");
  const outboxDrained = await waitOutboxEmpty();
  const db = parseJson<DbFacts>(await sql(dbFactsSql(prefix)), "consultas de correção");
  const reconciliation = await reconcileAll(`Bearer ${(await token("operator")).token}`, allWallets);
  const dlqDelta = (await dlqDepth()) - dlqBefore;

  const queuePrefix = `${prefix}-d`;
  if (queue !== undefined) {
    queue.result.processed = db.statusByPrefix[`${queuePrefix}:PROCESSED`] ?? 0;
    queue.result.rejected = db.statusByPrefix[`${queuePrefix}:REJECTED`] ?? 0;
  }

  const facts: RoundFacts = {
    wallets: { expected: allWallets.length, found: db.walletsFound },
    reconciliation,
    db: {
      negativeWallets: db.negativeWallets,
      balanceMismatches: db.balanceMismatches,
      processedWithoutLedger: db.processedWithoutLedger,
      ledgerWithoutProcessed: db.ledgerWithoutProcessed,
      nonTerminal: db.nonTerminal,
      unexpectedKinds: db.unexpectedKinds,
      unexpectedRejections: db.unexpectedRejections,
    },
    steps: httpRuns.map((r) => ({ name: r.result.label, ...r.facts, dbTransactions: db.byPrefix[r.prefix] ?? 0 })),
    duplicates:
      dup === undefined
        ? undefined
        : {
            keys: plan.duplicates.keys,
            dbTransactions: db.byPrefix[dup.prefix] ?? 0,
            fresh: dup.facts.fresh,
            unexpected: dup.facts.unexpected,
          },
    queue:
      queue === undefined
        ? undefined
        : {
            messages: plan.queue.messages,
            inbox: db.queueInbox,
            transactions: db.byPrefix[queuePrefix] ?? 0,
            dlqDelta,
            drained: queue.result.queueDrainS !== undefined && queue.facts.unexpected === 0,
          },
    outboxDrained,
  };
  const verdict = evaluateRound(facts);
  await writeFile(join(runner.outDir, `r${round}-facts.json`), JSON.stringify(facts, null, 2));
  console.log(verdict.ok ? "  correção: PASSOU" : `  correção: FALHOU\n${verdict.failures.map((f) => `    - ${f}`).join("\n")}`);
  const steps = [...httpRuns.map((r) => r.result)];
  if (dup !== undefined) steps.push(dup.result);
  if (queue !== undefined) steps.push(queue.result);
  return { round, steps, verdict };
}

// ---------------------------------------------------------------- ambiente

async function environment(): Promise<Record<string, string>> {
  const info = parseJson<{ NCPU: number; MemTotal: number; OperatingSystem: string; KernelVersion: string; ServerVersion: string }>(
    await runOk(["docker", "info", "--format", "{{json .}}"]),
    "docker info",
  );
  const cpu = cpus();
  const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  const commit = (await runOk(["git", "rev-parse", "--short", "HEAD"])).trim();
  const dirty = (await runOk(["git", "status", "--porcelain"])).trim() !== "";
  const k6 = (await runOk(["docker", "run", "--rm", K6_IMAGE, "version"])).trim().split("\n")[0] ?? "";
  return {
    "SO do host": `${version()} (${release()})`,
    "CPU do host": `${cpu[0]?.model.trim() ?? "?"} · ${cpu.length} threads lógicas`,
    "RAM do host": gb(totalmem()),
    "VM do Docker": `${info.NCPU} CPUs, ${gb(info.MemTotal)} · ${info.OperatingSystem} · kernel ${info.KernelVersion}`,
    Docker: `Engine ${info.ServerVersion} · Compose ${(await runOk(["docker", "compose", "version", "--short"])).trim()}`,
    "Bun (orquestrador e imagem da app)": Bun.version,
    k6: `${k6} (${K6_IMAGE})`,
    PostgreSQL: `${await sql("SHOW server_version;")} · max_connections ${await sql("SHOW max_connections;")}`,
    Topologia: "nginx → 3 api; 3 consumer; 2 outbox-publisher; 2 pending-worker; 1 event-auditor (D7.4), todos no mesmo host",
    Commit: `${commit}${dirty ? " (com mudanças não commitadas)" : ""}`,
  };
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const { rounds, scenarios } = parseLoadArgs(process.argv.slice(2));
  await assertTestInfraDown();
  await waitReady();
  const topo = await topology();

  const startedAt = new Date();
  const runId = startedAt.toISOString().replace(/[-:]/g, "").slice(0, 15);
  const outDir = join(REPO_ROOT, "logs", "load", runId);
  await mkdir(outDir, { recursive: true });
  console.log(`== test:load: ${rounds} rodada(s), saída em logs/load/${runId}/`);

  const env = await environment();
  const runner = new Runner(topo, outDir);
  const results: RoundResult[] = [];
  for (let round = 1; round <= rounds; round++) {
    results.push(await runRound(runner, topo, runId, round, scenarios, env));
  }

  const result: LoadResult = {
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    environment: env,
    tokenRequests,
    scenarios,
    rounds: results,
  };
  await writeFile(join(outDir, "result.json"), JSON.stringify(result, null, 2));
  await writeFile(join(outDir, "report.md"), renderReport(result));
  const failed = results.filter((r) => !r.verdict.ok);
  console.log(`\nRelatório: logs/load/${runId}/report.md`);
  if (failed.length > 0) {
    console.error(`test:load FALHOU na correção em ${failed.length} rodada(s) (D26.6).`);
    process.exit(1);
  }
  console.log("test:load: correção PASSOU em todas as rodadas.");
}

main().catch((error) => {
  console.error(`\ntest:load FALHOU: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Subprocess } from "bun";
import type { Client } from "pg";
import type { TestIssuer } from "./auth";
import type { ApiClient } from "./wagering";

/** Os processos da D7.4, cada um com o entrypoint de produção. */
export type ProcessKind = "api" | "consumer" | "outbox-publisher" | "pending-worker" | "event-auditor";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/**
 * Prefixo fixo das linhas de contagem do `outbox-publisher-child.ts`: não
 * se mistura com os logs JSON do pino (D21.4). Fica aqui porque importar o
 * child rodaria o bootstrap dele no processo do teste.
 */
export const PUBLISH_PREFIX = "PUBLISH ";
const READY_TIMEOUT_MS = 30_000;

export interface SpawnOptions {
  /** Nome da instância: vira o `DB_APPLICATION_NAME` (D21.1) e o nome do log. */
  instance: string;
  /** Variáveis por cima do ambiente do teste (`.env.test`). */
  env?: Record<string, string>;
  /** Padrão: `src/entrypoints/main-<kind>.ts`. Os entrypoints de teste trocam (D21.4). */
  entrypoint?: string;
}

export interface TestProcess {
  kind: ProcessKind;
  instance: string;
  /** Só na `api`: a porta livre que ela escuta. */
  baseUrl: string | undefined;
  /** Linhas de stdout e stderr, na ordem em que chegaram. */
  lines: string[];
  /** O processo saiu (por kill ou sozinho). */
  readonly exited: Promise<number>;
  /**
   * Estado síncrono: `true` enquanto o processo atual não saiu. Lê o
   * `exitCode` do Bun (nulo enquanto roda) e o flag setado no `exited`;
   * nunca uma corrida de promises (achado 1 da revisão da S8).
   */
  readonly running: boolean;
  /** Quantas vezes o processo foi (re)iniciado: 1 na subida, +1 a cada `restart()`. */
  readonly starts: number;
  /** Mata à força (no Windows, sem shutdown; D21.2) e espera sair. */
  kill(): Promise<void>;
  /** Mata à força e sobe de novo, com a mesma instância e a mesma porta. */
  restart(): Promise<void>;
  /** Manda o `SIGTERM` real (só fora do Windows faz shutdown; D21.2) e espera sair. */
  terminate(): Promise<number>;
}

/** Uma porta livre do sistema. */
export async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port;
  await probe.stop(true);
  if (port === undefined) throw new Error("porta livre não encontrada");
  return port;
}

async function pipeLines(stream: ReadableStream<Uint8Array>, lines: string[]): Promise<void> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    for (const part of parts) if (part.trim() !== "") lines.push(part.replace(/\r$/, ""));
  }
  if (pending.trim() !== "") lines.push(pending);
}

/** `msg` de uma linha JSON do pino, ou `undefined` se a linha não é JSON. */
function logMessage(line: string): string | undefined {
  if (!line.startsWith("{")) return undefined;
  try {
    return (JSON.parse(line) as { msg?: string }).msg;
  } catch {
    // Linha que começa com "{" mas não é JSON completo: não é um log do pino.
    return undefined;
  }
}

/** Espera uma condição (estado observável, sem `sleep`). */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`${what}: não aconteceu em ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Sobe um processo Bun separado com o entrypoint real (D7.4, D21.1),
 * contra a infra de teste. Pronto: a `api` responde `/health/live`; os
 * outros logam "<kind> iniciado". Todo processo deve ser registrado num
 * `ProcessGroup`, que mata o que sobrou e grava os logs.
 */
export async function spawnProcess(kind: ProcessKind, options: SpawnOptions): Promise<TestProcess> {
  const port = kind === "api" ? await freePort() : undefined;
  const entrypoint = options.entrypoint ?? join("src", "entrypoints", `main-${kind}.ts`);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    DB_APPLICATION_NAME: options.instance,
    ...(port !== undefined && { PORT: String(port) }),
    ...options.env,
  };
  const lines: string[] = [];
  let proc: Subprocess<"ignore", "pipe", "pipe">;
  let exited: Promise<number>;
  let gone = false;
  let starts = 0;

  async function start(): Promise<void> {
    const from = lines.length;
    starts++;
    gone = false;
    proc = Bun.spawn([process.execPath, entrypoint], {
      cwd: REPO_ROOT,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    // `exited` só resolve depois de o stdout e o stderr drenarem: quem lê
    // `lines` depois de um kill vê tudo o que o processo escreveu.
    const drained = Promise.all([pipeLines(proc.stdout, lines), pipeLines(proc.stderr, lines)]);
    exited = Promise.all([proc.exited, drained]).then(([code]) => code);
    const current = proc;
    void current.exited.then(() => {
      if (proc === current) gone = true;
    });
    await waitFor(
      async () => {
        if (gone) throw new Error(`${options.instance} saiu antes de ficar pronto:\n${lines.slice(from).join("\n")}`);
        if (port !== undefined) {
          try {
            return (await fetch(`http://127.0.0.1:${port}/health/live`)).ok;
          } catch {
            // Ainda não escuta: conexão recusada até o `listen`.
            return false;
          }
        }
        return lines.slice(from).some((line) => logMessage(line) === `${kind} iniciado`);
      },
      `${options.instance} pronto`,
      READY_TIMEOUT_MS,
    );
  }

  await start();

  const handle: TestProcess = {
    kind,
    instance: options.instance,
    baseUrl: port === undefined ? undefined : `http://127.0.0.1:${port}`,
    lines,
    get exited() {
      return exited;
    },
    get running() {
      return !gone && proc.exitCode === null && proc.signalCode === null;
    },
    get starts() {
      return starts;
    },
    async kill() {
      proc.kill("SIGKILL");
      await exited;
    },
    async restart() {
      proc.kill("SIGKILL");
      await exited;
      lines.push(`--- ${options.instance} reiniciado pelo teste ---`);
      await start();
    },
    async terminate() {
      proc.kill("SIGTERM");
      return exited;
    },
  };
  return handle;
}

/**
 * O `leaseToken` (o `locked_by` que a instância grava, D18.10, D20.5) que o
 * worker ou o publisher logou na subida mais recente.
 */
export function leaseTokenOf(process: Pick<TestProcess, "kind" | "instance" | "lines">): string {
  for (const line of [...process.lines].reverse()) {
    if (logMessage(line) !== `${process.kind} iniciado`) continue;
    const { leaseToken } = JSON.parse(line) as { leaseToken?: string };
    if (typeof leaseToken === "string") return leaseToken;
  }
  throw new Error(`${process.instance} não logou o leaseToken na subida`);
}

/** Variáveis de auth para uma `api` separada validar os tokens do emissor de teste (D10.3). */
export function authEnv(issuer: TestIssuer): Record<string, string> {
  return {
    AUTH_ISSUER: issuer.config.issuer,
    AUTH_AUDIENCE: issuer.config.audience,
    AUTH_JWKS_URL: issuer.config.jwksUrl,
    AUTH_JWKS_TIMEOUT_MS: String(issuer.config.jwksTimeoutMs),
  };
}

/** Os helpers de `wagering.ts` (`createWallet`, `submit`) falando com a `api` de outro processo. */
export function apiClient(process: Pick<TestProcess, "baseUrl" | "instance">, issuer: TestIssuer): ApiClient {
  const { baseUrl } = process;
  if (baseUrl === undefined) throw new Error(`${process.instance} não é uma api`);
  return {
    issuer,
    async request(method, path, options = {}) {
      const headers: Record<string, string> = { ...options.headers };
      const token = options.token === undefined ? await issuer.operatorToken() : options.token;
      if (token !== null) headers.authorization = `Bearer ${token}`;
      if (options.body !== undefined) headers["content-type"] = "application/json";
      return fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    },
  };
}

/**
 * Os processos de um teste: `close()` mata o que sobrou e grava o log de
 * cada um em `logs/processes/<teste>/` (a pasta `/logs` é ignorada pelo git).
 */
export class ProcessGroup {
  readonly all: TestProcess[] = [];

  constructor(private readonly name: string) {}

  async spawn(kind: ProcessKind, options: SpawnOptions): Promise<TestProcess> {
    const started = await spawnProcess(kind, options);
    this.all.push(started);
    return started;
  }

  async close(): Promise<void> {
    await Promise.all(this.all.map((p) => p.kill()));
    const dir = join(REPO_ROOT, "logs", "processes", `${new Date().toISOString().replaceAll(":", "-")}-${this.name}`);
    await mkdir(dir, { recursive: true });
    await Promise.all(this.all.map((p) => writeFile(join(dir, `${p.instance}.log`), `${p.lines.join("\n")}\n`)));
  }
}

/**
 * Nomes de aplicação (`application_name`, D21.1) das sessões esperando o
 * lock da wallet travada pela sessão `holderPid`: a primeira espera no
 * `transactionid` do dono; as seguintes, no lock de tupla dessa linha.
 */
export async function walletLockWaiterApps(
  observer: Client,
  lock: { pid: number; walletId: string },
): Promise<string[]> {
  const { rows } = await observer.query<{ app: string }>(
    `WITH target AS (
       SELECT (ctid::text::point)[0]::int AS page, (ctid::text::point)[1]::int AS tuple
         FROM wallets WHERE id = $2
     )
     SELECT a.application_name AS app
       FROM pg_locks waiter
       JOIN pg_stat_activity a ON a.pid = waiter.pid, target
      WHERE NOT waiter.granted
        AND waiter.pid <> $1
        AND (
          (waiter.locktype = 'transactionid' AND waiter.transactionid IN (
             SELECT holder.transactionid FROM pg_locks holder
              WHERE holder.pid = $1 AND holder.locktype = 'transactionid'
                AND holder.mode = 'ExclusiveLock' AND holder.granted))
          OR (waiter.locktype = 'tuple'
              AND waiter.relation = 'wallets'::regclass
              AND waiter.page = target.page
              AND waiter.tuple = target.tuple)
        )`,
    [lock.pid, lock.walletId],
  );
  return rows.map((row) => row.app);
}

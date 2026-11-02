import { beforeAll, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../../../src/shared/config/config";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

interface ComposeService {
  image?: string;
  build?: unknown;
  command?: string[] | null;
  entrypoint?: string[] | null;
  init?: boolean;
  ports?: { published?: string | number; target?: number }[];
  depends_on?: Record<string, unknown>;
  deploy?: { replicas?: number };
  stop_grace_period?: string;
  environment?: Record<string, string>;
  volumes?: { source?: string; target?: string }[];
}

/** Os processos da D7.4 e quantas instâncias cada um tem. */
const TOPOLOGY: Record<string, number> = {
  "main-api.ts": 3,
  "main-consumer.ts": 3,
  "main-outbox-publisher.ts": 2,
  "main-pending-worker.ts": 2,
  "main-event-auditor.ts": 1,
};

const SHELLS = ["sh", "bash", "/bin/sh", "/bin/bash", "ash", "/bin/ash"];

let services: Record<string, ComposeService>;

/** O Compose como o Docker o interpreta (`docker compose config`), não o texto do YAML. */
beforeAll(async () => {
  const proc = Bun.spawn(["docker", "compose", "-f", "docker-compose.yml", "config", "--format", "json"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`docker compose config falhou: ${err}`);
  services = (JSON.parse(out) as { services: Record<string, ComposeService> }).services;
});

/** Serviços que rodam um entrypoint da D7.4. */
function processServices(): [string, ComposeService, string][] {
  return Object.entries(services).flatMap(([name, service]) => {
    const entry = (service.command ?? []).find((arg) => arg.startsWith("src/entrypoints/main-"));
    return entry === undefined ? [] : [[name, service, entry.slice("src/entrypoints/".length)] as [string, ComposeService, string]];
  });
}

describe("D7.4 D21.2: topologia do Compose", () => {
  it("D7.4: api ×3, consumer ×3, outbox-publisher ×2, pending-worker ×2 e event-auditor ×1", () => {
    const counts: Record<string, number> = {};
    for (const [, service, entry] of processServices()) {
      counts[entry] = (counts[entry] ?? 0) + (service.deploy?.replicas ?? 1);
    }
    expect(counts).toEqual(TOPOLOGY);
  });

  it("D7.4: o nginx publica a porta 3000 e encaminha às 3 api, que não publicam porta", () => {
    const nginx = services.nginx;
    expect(nginx).toBeDefined();
    expect(nginx?.ports?.map((p) => String(p.published))).toEqual(["3000"]);
    const apis = processServices().filter(([, , entry]) => entry === "main-api.ts");
    for (const [name, service] of apis) {
      expect({ name, ports: service.ports ?? [] }).toEqual({ name, ports: [] });
      expect(Object.keys(nginx?.depends_on ?? {})).toContain(name);
    }
  });

  it("D7.4 D21.6: o ambiente de cada processo do Compose passa na validação da config (sem o .env.test por trás)", () => {
    for (const [name, service] of processServices()) {
      const env = service.environment ?? {};
      let error: string | undefined;
      try {
        loadConfig(env);
      } catch (thrown) {
        error = thrown instanceof Error ? thrown.message : String(thrown);
      }
      expect({ name, error }).toEqual({ name, error: undefined });
    }
  });

  it("D8.5 D8.6: todo processo da D7.4 tem 30 s para parar (stop_grace_period)", () => {
    for (const [name, service] of processServices()) {
      expect({ name, grace: service.stop_grace_period }).toEqual({ name, grace: "30s" });
    }
  });

  it("D21.2: o Dockerfile usa ENTRYPOINT e CMD em forma exec, com o bun como PID 1", async () => {
    const dockerfile = await readFile(join(REPO_ROOT, "Dockerfile"), "utf8");
    const instructions = dockerfile
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^(ENTRYPOINT|CMD)\s/.test(line));
    expect(instructions.length).toBeGreaterThan(0);
    for (const line of instructions) {
      const args = line.replace(/^(ENTRYPOINT|CMD)\s+/, "");
      // Forma shell (`ENTRYPOINT bun run`) vira `/bin/sh -c …`, e o sinal fica no shell.
      expect({ line, exec: args.startsWith("[") }).toEqual({ line, exec: true });
    }
    const entrypoint = instructions.find((line) => line.startsWith("ENTRYPOINT"));
    expect(JSON.parse((entrypoint ?? "ENTRYPOINT []").replace(/^ENTRYPOINT\s+/, ""))[0]).toBe("bun");
  });

  it("D21.2: nenhum serviço da D7.4 roda o bun por trás de um shell", () => {
    const services = processServices();
    expect(services.length).toBeGreaterThan(0);
    for (const [name, service] of services) {
      const entrypoint = service.entrypoint ?? [];
      const command = service.command ?? [];
      // Sem entrypoint próprio, vale o do Dockerfile (forma exec, teste acima).
      expect({ name, entrypoint: entrypoint[0] ?? "bun" }).toEqual({ name, entrypoint: "bun" });
      expect({ name, shell: SHELLS.includes(command[0] ?? "") || command.includes("-c") }).toEqual({
        name,
        shell: false,
      });
    }
  });
});

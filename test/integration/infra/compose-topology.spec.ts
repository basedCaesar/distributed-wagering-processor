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
let testServices: Record<string, ComposeService>;

/** O Compose como o Docker o interpreta (`docker compose config`), não o texto do YAML. */
async function composeConfig(file: string): Promise<Record<string, ComposeService>> {
  const proc = Bun.spawn(["docker", "compose", "-f", file, "config", "--format", "json"], {
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
  return (JSON.parse(out) as { services: Record<string, ComposeService> }).services;
}

beforeAll(async () => {
  services = await composeConfig("docker-compose.yml");
  testServices = await composeConfig("docker-compose.test.yml");
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

  it("D7.4: a imagem do nginx é uma versão exata ≥ 1.27.3 (o `resolve` do upstream não existe antes)", () => {
    const image = services.nginx?.image ?? "";
    const match = /^nginx:(\d+)\.(\d+)\.(\d+)(?:-alpine)?$/.exec(image);
    expect({ image, exact: match !== null }).toEqual({ image, exact: true });
    const [major = 0, minor = 0, patch = 0] = (match?.slice(1) ?? []).map((part) => Number.parseInt(part, 10));
    // major.minor.patch como um número só (cada parte < 1000): 1.27.3 → 1_027_003.
    const atLeast = major * 1_000_000 + minor * 1_000 + patch >= 1_027_003;
    expect({ image, atLeast_1_27_3: atLeast }).toEqual({ image, atLeast_1_27_3: true });
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

describe("D23: Keycloak e seed no Compose", () => {
  it("D23.3 D10.1: AUTH_ISSUER das 3 api = KC_HOSTNAME do keycloak + /realms/wagering; JWKS pela rede interna", () => {
    const hostname = services.keycloak?.environment?.KC_HOSTNAME;
    expect(hostname).toBe("http://localhost:8080");
    expect(services.keycloak?.environment?.KC_HOSTNAME_BACKCHANNEL_DYNAMIC).toBe("true");
    const apis = processServices().filter(([, , entry]) => entry === "main-api.ts");
    expect(apis.length).toBe(3);
    for (const [name, service] of apis) {
      const env = service.environment ?? {};
      expect({ name, issuer: env.AUTH_ISSUER, jwks: env.AUTH_JWKS_URL }).toEqual({
        name,
        issuer: `${hostname}/realms/wagering`,
        jwks: "http://keycloak:8080/realms/wagering/protocol/openid-connect/certs",
      });
    }
  });

  it("D23.3 D23.4: o keycloak publica a 8080 e importa o realm do repositório; imagem com versão exata da linha 26", () => {
    const keycloak = services.keycloak;
    expect(keycloak?.ports?.map((p) => String(p.published))).toEqual(["8080"]);
    expect(keycloak?.image ?? "").toMatch(/^quay\.io\/keycloak\/keycloak:26\.\d+\.\d+$/);
    expect(keycloak?.command ?? []).toContain("--import-realm");
    expect(keycloak?.volumes?.map((v) => v.target)).toContain("/opt/keycloak/data/import/realm-wagering.json");
  });

  it("D23.1: o seed roda o script do exemplo depois do migrate, só no Compose de dev", () => {
    const seed = services.seed;
    expect(seed?.command).toEqual(["scripts/seed-examples.ts"]);
    expect(Object.keys(seed?.depends_on ?? {})).toContain("migrate");
    expect(testServices.seed).toBeUndefined();
  });

  it("D23.3 D23.5: o Keycloak de teste publica a 8081 com KC_HOSTNAME = E2E_KEYCLOAK_URL do .env.test", async () => {
    const keycloak = testServices.keycloak_test;
    expect(keycloak?.ports?.map((p) => String(p.published))).toEqual(["8081"]);
    const envTest = await readFile(join(REPO_ROOT, ".env.test"), "utf8");
    const url = /^E2E_KEYCLOAK_URL=(.+)$/m.exec(envTest)?.[1]?.trim();
    expect(url).toBe("http://localhost:8081");
    expect(keycloak?.environment?.KC_HOSTNAME).toBe(url);
    expect(keycloak?.image).toBe(services.keycloak?.image);
  });
});

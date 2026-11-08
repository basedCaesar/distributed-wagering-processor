import http from "k6/http";
import { env } from "./common.ts";

/**
 * Lê o `/metrics` interno (D22.1) de todos os processos, antes e depois de
 * cada passo (D26.4). Roda na rede do Compose: nenhuma porta é exposta. O
 * texto cru vai para o arquivo; quem faz as contas é o orquestrador.
 */

export const options = { vus: 1, iterations: 1 };

export function setup(): Record<string, string> {
  const scrapes: Record<string, string> = {};
  for (const target of env("LOAD_TARGETS").split(",")) {
    const res = http.get(`http://${target}/metrics`, { timeout: "5s" });
    if (res.status !== 200 || typeof res.body !== "string") {
      throw new Error(`/metrics de ${target}: status ${res.status}`);
    }
    scrapes[target] = res.body;
  }
  return scrapes;
}

export default function (): void {}

export function handleSummary(data: { setup_data?: unknown }): Record<string, string> {
  return { [env("LOAD_SUMMARY")]: JSON.stringify(data.setup_data ?? null) };
}

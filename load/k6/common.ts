import { sleep } from "k6";
import http from "k6/http";
import { Counter, Trend } from "k6/metrics";
import { LOAD_PLAN } from "../lib/plan.ts";
import { gaugeMax, parsePrometheus } from "../lib/prometheus.ts";

/**
 * Peças comuns aos scripts do k6 (D26.1): leitura do `/metrics` interno dos
 * publishers (D22.1, D26.4), espera da outbox e o resumo em JSON que o
 * orquestrador lê. Tudo que vem do orquestrador chega por `__ENV`.
 */

export function env(name: string): string {
  const value = __ENV[name];
  if (value === undefined || value === "") throw new Error(`variável ${name} ausente`);
  return value;
}

export interface LoadWallet {
  walletId: string;
  playerId: string;
}

/** As wallets que o orquestrador criou para o passo (D26.3). */
export function loadWallets(): LoadWallet[] {
  const wallets = JSON.parse(open(env("LOAD_WALLETS_FILE"))) as LoadWallet[];
  if (wallets.length === 0) throw new Error("nenhuma wallet no arquivo do passo");
  return wallets;
}

/** A wallet de índice `i`, em rodízio. */
export function walletAt(wallets: LoadWallet[], i: number): LoadWallet {
  const wallet = wallets[i % wallets.length];
  if (wallet === undefined) throw new Error(`wallet ${i} fora da lista`);
  return wallet;
}

/** `outbox_lag_seconds` e `outbox_pending_events` (D22.6), o maior entre os publishers. */
export const outboxLag = new Trend("outbox_lag");
export const outboxPending = new Trend("outbox_pending");
/** Do fim da carga até a outbox vazia. */
export const outboxDrainSeconds = new Trend("outbox_drain_seconds");
export const outboxDrainTimeout = new Counter("outbox_drain_timeout");
export const scrapeFailures = new Counter("scrape_failures");

const publishers = (): string[] => env("LOAD_PUBLISHERS").split(",");

/** Uma leitura dos publishers. `undefined`: alguma leitura falhou (contada). */
export function sampleOutbox(): { lag: number; pending: number } | undefined {
  const scrapes = [];
  for (const target of publishers()) {
    const res = http.get(`http://${target}/metrics`, { tags: { name: "metrics" }, timeout: "5s" });
    if (res.status !== 200 || typeof res.body !== "string") {
      scrapeFailures.add(1);
      return undefined;
    }
    scrapes.push(parsePrometheus(res.body));
  }
  const lag = gaugeMax(scrapes, "outbox_lag_seconds");
  const pending = gaugeMax(scrapes, "outbox_pending_events");
  if (lag === undefined || pending === undefined) {
    scrapeFailures.add(1);
    return undefined;
  }
  outboxLag.add(lag);
  outboxPending.add(pending);
  return { lag, pending };
}

/** Espera a outbox esvaziar (nenhum pendente), lendo a cada 1 s, com teto (D26.4). */
export function waitOutboxDrain(): void {
  const start = Date.now();
  const deadline = start + LOAD_PLAN.drainTimeoutS * 1000;
  while (Date.now() < deadline) {
    const sample = sampleOutbox();
    if (sample !== undefined && sample.pending === 0) {
      outboxDrainSeconds.add((Date.now() - start) / 1000);
      return;
    }
    sleep(1);
  }
  outboxDrainTimeout.add(1);
}

/** Cenário que lê a outbox a cada 1 s durante a carga. */
export function samplerScenario(durationS: number) {
  return {
    executor: "constant-arrival-rate",
    exec: "sample",
    rate: 1,
    timeUnit: "1s",
    duration: `${durationS}s`,
    preAllocatedVUs: 2,
    maxVUs: 4,
  } as const;
}

/** Percentis de todas as amostras (não os buckets) no resumo. */
export const SUMMARY_TREND_STATS = ["p(50)", "p(95)", "p(99)", "max", "count"];

interface SummaryData {
  metrics: Record<string, { type: string; values: Record<string, number> }>;
  setup_data?: unknown;
}

/** O resumo vai para o arquivo pedido pelo orquestrador; nada de texto no stdout. */
export function writeSummary(data: SummaryData): Record<string, string> {
  const metrics: Record<string, Record<string, number>> = {};
  for (const [name, metric] of Object.entries(data.metrics)) metrics[name] = metric.values;
  return { [env("LOAD_SUMMARY")]: JSON.stringify({ metrics, setup: data.setup_data ?? null }) };
}

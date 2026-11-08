import { sleep } from "k6";
import exec from "k6/execution";
import http from "k6/http";
import { Counter, Trend } from "k6/metrics";
import { classifySubmission, retryAfterSeconds } from "../lib/classify.ts";
import { LOAD_PLAN } from "../lib/plan.ts";
import {
  env,
  loadWallets,
  SUMMARY_TREND_STATS,
  sampleOutbox,
  samplerScenario,
  waitOutboxDrain,
  walletAt,
  writeSummary,
} from "./common.ts";

/**
 * Um passo HTTP do `test:load` (D26.2): `POST /wagering/transactions` pelo
 * nginx (3 `api`), com o token do `provider-a` que o orquestrador pediu para
 * este passo (D26.3).
 *
 * - `warmup`, `A`, `B`: chegadas por segundo constantes (modelo aberto), uma
 *   key nova por chegada;
 * - `C`: cada VU manda as mesmas keys na mesma ordem, então a k-ésima
 *   iteração dos `copies` VUs é a mesma key quase ao mesmo tempo.
 *
 * `503` é reenviado com a mesma key (D26.5). Depois da carga, o teardown
 * espera a outbox esvaziar (D26.4).
 */

type Scenario = "warmup" | "A" | "B" | "C";

const SCENARIO = env("LOAD_SCENARIO") as Scenario;
const PREFIX = env("LOAD_PREFIX");
const API = env("LOAD_API");
const TOKEN = env("LOAD_TOKEN");
const RATE = Number(__ENV.LOAD_RATE ?? "0");
const DURATION_S = Number(__ENV.LOAD_DURATION_S ?? "0");
const WALLETS = loadWallets();

const ops = new Counter("ops");
const resolved = new Counter("resolved");
const processed = new Counter("processed");
const rejected = new Counter("rejected");
const replays = new Counter("replays");
const fresh = new Counter("fresh");
const transientAttempts = new Counter("transient_attempts");
const gaveUp = new Counter("gave_up");
const unexpected = new Counter("unexpected");
const reqDuration = new Trend("req_duration", true);
const opDuration = new Trend("op_duration", true);
const loadElapsed = new Trend("load_elapsed_seconds");

/** No máximo 5 linhas de status inesperado por VU: só o status e o código do erro (D11.1). */
let unexpectedLogged = 0;

function mainScenario() {
  if (SCENARIO === "C") {
    const { copies, keys, maxDurationS } = LOAD_PLAN.duplicates;
    return { executor: "per-vu-iterations", vus: copies, iterations: keys, maxDuration: `${maxDurationS}s` } as const;
  }
  return {
    executor: "constant-arrival-rate",
    rate: RATE,
    timeUnit: "1s",
    duration: `${DURATION_S}s`,
    preAllocatedVUs: Math.max(10, RATE),
    maxVUs: Math.min(600, Math.max(50, RATE * 4)),
    gracefulStop: `${LOAD_PLAN.gracefulStopS}s`,
  } as const;
}

export const options = {
  scenarios: {
    main: { ...mainScenario(), exec: "submit" },
    sampler: samplerScenario(SCENARIO === "C" ? LOAD_PLAN.duplicates.maxDurationS : DURATION_S),
  },
  summaryTrendStats: SUMMARY_TREND_STATS,
  // A espera da outbox tem teto próprio (D26.4); o padrão do k6 (60 s) cortaria antes.
  teardownTimeout: `${LOAD_PLAN.drainTimeoutS + 30}s`,
  // Sem thresholds: latência nunca reprova o test:load (D26.6).
  discardResponseBodies: false,
  noConnectionReuse: false,
};

interface Operation {
  key: number;
  walletId: string;
  playerId: string;
  kind: "BET" | "WIN";
  amount: string;
}

function operationFor(iteration: number): Operation {
  if (SCENARIO === "C") {
    // A k-ésima iteração de todo VU é a mesma key.
    const key = exec.vu.iterationInScenario;
    return { key, ...walletAt(WALLETS, key), kind: "BET", amount: LOAD_PLAN.duplicates.betAmount };
  }
  if (SCENARIO === "B") {
    return { key: iteration, ...walletAt(WALLETS, 0), kind: "BET", amount: LOAD_PLAN.hotWallet.betAmount };
  }
  const wallet = walletAt(WALLETS, iteration);
  const isBet = iteration % 10 < 7;
  const { betAmount, winAmount } = LOAD_PLAN.throughput;
  return { key: iteration, ...wallet, kind: isBet ? "BET" : "WIN", amount: isBet ? betAmount : winAmount };
}

function parseBody(body: unknown): unknown {
  if (typeof body !== "string" || body === "") return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

export function setup(): { start: number } {
  return { start: Date.now() };
}

export function submit(): void {
  const op = operationFor(exec.scenario.iterationInTest);
  const externalTransactionId = `${PREFIX}-${op.key}`;
  const body = JSON.stringify({
    providerId: "provider-a",
    externalTransactionId,
    playerId: op.playerId,
    walletId: op.walletId,
    roundId: `${PREFIX}-round-${op.key}`,
    gameId: "load-test",
    kind: op.kind,
    money: { amount: op.amount, currency: "BRL" },
  });
  const params = {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `provider-a:${externalTransactionId}`,
    },
    tags: { name: "submit" },
    timeout: "20s",
  };

  ops.add(1);
  const start = Date.now();
  for (let attempt = 1; attempt <= LOAD_PLAN.maxAttempts; attempt++) {
    const res = http.post(`${API}/wagering/transactions`, body, params);
    reqDuration.add(res.timings.duration);
    const result = classifySubmission(res.status, parseBody(res.body));
    if (result.outcome === "transient") {
      transientAttempts.add(1);
      if (attempt === LOAD_PLAN.maxAttempts) {
        gaveUp.add(1);
        break;
      }
      sleep(retryAfterSeconds(res.headers["Retry-After"]));
      continue;
    }
    if (result.outcome === "unexpected") {
      unexpected.add(1);
      if (unexpectedLogged < 5) {
        unexpectedLogged++;
        console.log(`UNEXPECTED status=${res.status} code=${result.errorCode ?? "-"} error=${res.error_code}`);
      }
      break;
    }
    resolved.add(1);
    (result.outcome === "processed" ? processed : rejected).add(1);
    (result.replay ? replays : fresh).add(1);
    break;
  }
  opDuration.add(Date.now() - start);
}

export function sample(): void {
  sampleOutbox();
}

export function teardown(data: { start: number }): void {
  loadElapsed.add((Date.now() - data.start) / 1000);
  waitOutboxDrain();
}

export const handleSummary = writeSummary;

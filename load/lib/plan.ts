import { coveredAmount } from "./money.ts";

/**
 * O experimento do `test:load` (D26.2), fixo no código: cenários, degraus,
 * durações e tamanhos. Só o número de rodadas vem da linha de comando.
 * Código puro: o orquestrador e o k6 leem daqui.
 */

export interface RateStep {
  /** Chegadas por segundo (modelo aberto: não espera a resposta, D26.2). */
  rate: number;
  durationS: number;
}

export const LOAD_PLAN = {
  /** Descartado: aquece JIT, pools e caches antes do 1º degrau medido. */
  warmup: { rate: 25, durationS: 15 },
  /** A: muitas wallets em paralelo; 70% BET, 30% WIN sem referência (D1.6). */
  throughput: {
    wallets: 200,
    initialBalance: "1000000.00",
    betAmount: "5.00",
    winAmount: "5.00",
    // 30 s por degrau (D26.2): com 60 s, as 3 rodadas levavam ~2h10.
    steps: [
      { rate: 50, durationS: 30 },
      { rate: 100, durationS: 30 },
      { rate: 200, durationS: 30 },
      { rate: 400, durationS: 30 },
    ],
  },
  /** B: uma wallet nova por degrau, disputada; saldo para 70% das BETs. */
  hotWallet: {
    betAmount: "1.00",
    coveredFraction: { numerator: 7, denominator: 10 },
    steps: [
      { rate: 10, durationS: 30 },
      { rate: 25, durationS: 30 },
      { rate: 50, durationS: 30 },
      { rate: 100, durationS: 30 },
    ],
  },
  /**
   * C: cada key enviada `copies` vezes no mesmo instante (um VU por cópia).
   * As cópias da key k partem em `início + k × slotS`, com o início calculado
   * no setup `leadS` à frente; o slot é maior que o p99 de uma key (~2,3 s)
   * para uma key não atrasar a próxima.
   */
  duplicates: {
    wallets: 10,
    initialBalance: "100.00",
    betAmount: "1.00",
    keys: 50,
    copies: 20,
    leadS: 3,
    slotS: 3,
    maxDurationS: 190,
  },
  /** D: mensagens do §10 pela fila, `MessageGroupId` = walletId (D8.1). */
  queue: { wallets: 100, initialBalance: "100.00", betAmount: "1.00", messages: 2000, batchSize: 10 },
  /** Reenvios de um `503` com a mesma key, respeitando o `Retry-After` (D26.5). */
  maxAttempts: 5,
  /** Teto da espera da outbox e da fila depois da carga (D26.4). */
  drainTimeoutS: 180,
  /** Teto da espera do repouso antes de cada passo (D26.11). */
  quiesceTimeoutS: 600,
  /** Prazo extra do k6 para as iterações em andamento no fim do passo. */
  gracefulStopS: 30,
} as const;

export const DEFAULT_ROUNDS = 3;
const MAX_ROUNDS = 10;

export const SCENARIOS = ["A", "B", "C", "D"] as const;
export type ScenarioId = (typeof SCENARIOS)[number];

export interface LoadArgs {
  rounds: number;
  /** D26.12: só para iterar; o relatório final roda todos. Sempre na ordem do plano. */
  scenarios: ScenarioId[];
}

function parseScenarios(raw: string | undefined): ScenarioId[] {
  const usage = `--scenarios precisa de uma lista separada por vírgula de ${SCENARIOS.join(", ")}`;
  if (raw === undefined || raw === "") throw new Error(usage);
  const chosen = raw.split(",");
  for (const id of chosen) {
    if (!(SCENARIOS as readonly string[]).includes(id)) throw new Error(`${usage}; recebi "${id}"`);
  }
  return SCENARIOS.filter((id) => chosen.includes(id));
}

function parseRounds(raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw)) throw new Error(`--rounds precisa de um inteiro entre 1 e ${MAX_ROUNDS}`);
  const rounds = Number(raw);
  if (rounds < 1 || rounds > MAX_ROUNDS) throw new Error(`--rounds precisa de um inteiro entre 1 e ${MAX_ROUNDS}`);
  return rounds;
}

/** `bun run test:load [--rounds N] [--scenarios A,B,C,D]`, padrão 3 rodadas de todos (D26.2, D26.12). */
export function parseLoadArgs(argv: readonly string[]): LoadArgs {
  let rounds = DEFAULT_ROUNDS;
  let scenarios: ScenarioId[] = [...SCENARIOS];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--rounds") {
      rounds = parseRounds(argv[i + 1]);
      i++;
    } else if (arg.startsWith("--rounds=")) {
      rounds = parseRounds(arg.slice("--rounds=".length));
    } else if (arg === "--scenarios") {
      scenarios = parseScenarios(argv[i + 1]);
      i++;
    } else if (arg.startsWith("--scenarios=")) {
      scenarios = parseScenarios(arg.slice("--scenarios=".length));
    } else {
      throw new Error(`argumento desconhecido: ${arg} (uso: bun run test:load [--rounds N] [--scenarios A,B,C,D])`);
    }
  }
  return { rounds, scenarios };
}

/** Saldo da hot wallet do degrau: cobre a fração configurada das BETs previstas (D26.2), em centavos bigint (D2). */
export function hotWalletBalance(step: RateStep, betAmount: string): string {
  return coveredAmount(step.rate * step.durationS, LOAD_PLAN.hotWallet.coveredFraction, betAmount);
}

/** C (D26.6): tag das respostas originais, para contá-las key a key no `--out json`. */
export const DUPLICATE_KEY_TAG = "dupkey";

/** C (D26.2): instante absoluto em que as cópias da key `key` partem juntas. */
export function duplicateSendAtMs(startAtMs: number, key: number): number {
  return startAtMs + key * LOAD_PLAN.duplicates.slotS * 1000;
}

/** C: do setup ao instante da última key. */
export function duplicateScheduleS(): number {
  const { leadS, keys, slotS } = LOAD_PLAN.duplicates;
  return leadS + keys * slotS;
}

/** Quanto tempo o token do passo precisa valer: o passo e o prazo extra do k6. */
export function stepSeconds(step: { durationS: number }): number {
  return step.durationS + LOAD_PLAN.gracefulStopS;
}

const TOKEN_MARGIN_S = 60;

/** D26.3: um token por passo, que vale o passo inteiro com folga. */
export function tokenCovers(expiresInS: number, stepS: number): boolean {
  return expiresInS >= stepS + TOKEN_MARGIN_S;
}

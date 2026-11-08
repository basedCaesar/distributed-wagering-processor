import type { Scrape } from "./prometheus";

/**
 * Repouso entre passos (D26.11): um passo não começa enquanto o anterior
 * ainda ocupa o sistema. Código puro; o orquestrador faz as leituras e grava,
 * a cada uma, o motivo de ainda não estar em repouso.
 */

export interface QuietSample {
  /** Eventos não publicados na outbox. */
  outboxPending: number;
  /** Sessões da app no banco fora de `idle`, por `application_name` (D21.1). */
  activeByProcess: Record<string, number>;
  /** Operações concluídas até agora, somadas entre as instâncias (D22.7): só `_count`, inteiros. */
  completed: number;
}

export interface NotQuietReason {
  /** Conjunto fechado, para o resumo do passo. */
  reason: string;
  /** Com os números da leitura, para o log. */
  detail: string;
}

/**
 * Processos fora da condição de repouso (D26.13): o `event-auditor` (uma
 * instância) consome ~17 eventos/s, contra centenas/s do publisher, e levaria
 * horas para alcançar. O atraso dele é registrado à parte antes de cada passo.
 */
export const QUIET_IGNORED_PROCESSES: readonly string[] = ["event-auditor"];

/** Por que esta leitura ainda não é repouso; vazio = repouso. */
export function notQuietReasons(previous: QuietSample | undefined, current: QuietSample): NotQuietReason[] {
  if (previous === undefined) return [{ reason: "1ª leitura", detail: "1ª leitura" }];
  const reasons: NotQuietReason[] = [];
  if (current.outboxPending > 0) {
    reasons.push({ reason: "outbox com pendentes", detail: `outbox: ${current.outboxPending} pendentes` });
  }
  for (const [process, n] of Object.entries(current.activeByProcess).sort(([a], [b]) => a.localeCompare(b))) {
    if (n > 0 && !QUIET_IGNORED_PROCESSES.includes(process)) reasons.push({ reason: `sessão ativa: ${process}`, detail: `sessão ativa: ${process} (${n})` });
  }
  if (current.completed !== previous.completed) {
    reasons.push({ reason: "operações concluídas", detail: `operações concluídas: +${current.completed - previous.completed}` });
  }
  return reasons;
}

/** Repouso: outbox vazia, nenhuma sessão ativa e nenhuma operação concluída desde a leitura anterior. */
export function isQuiet(previous: QuietSample | undefined, current: QuietSample): boolean {
  return notQuietReasons(previous, current).length === 0;
}

/** Resumo do passo: em quantas leituras cada motivo segurou o repouso. */
export function summarizeHolds(readings: NotQuietReason[][]): Record<string, number> {
  const holds: Record<string, number> = {};
  for (const reasons of readings) {
    for (const { reason } of reasons) holds[reason] = (holds[reason] ?? 0) + 1;
  }
  return holds;
}

export interface QueueReading {
  depth: number;
  atMs: number;
}

const MIN_RATE_INTERVAL_MS = 5000;

/**
 * D26.13: a janela da vazão do auditor só abre com a outbox vazia (antes
 * disso, o publisher ainda enche a fila dele e a queda subestima o consumo).
 * - `wait`: outbox com pendentes; sem janela (se havia uma, recomeça);
 * - `start`: outbox vazia e sem janela: ler a fila agora e abrir;
 * - `keep`: janela aberta e outbox vazia.
 */
export function auditorWindow(start: QueueReading | undefined, outboxPending: number): "wait" | "start" | "keep" {
  if (outboxPending > 0) return "wait";
  return start === undefined ? "start" : "keep";
}

/**
 * D26.13: mensagens que o auditor consumiu por segundo entre duas leituras da
 * fila dele, as duas com a outbox vazia (`auditorWindow`): nada entra na
 * fila, então a queda é o consumo. `undefined`: fila vazia ou intervalo curto
 * demais.
 */
export function auditorDrainRate(before: QueueReading, after: QueueReading): number | undefined {
  const elapsedMs = after.atMs - before.atMs;
  if (before.depth === 0 || elapsedMs < MIN_RATE_INTERVAL_MS) return undefined;
  return ((before.depth - after.depth) * 1000) / elapsedMs;
}

/** Soma dos `wagering_processing_duration_seconds_count` (todos os canais e desfechos) das instâncias. */
export function completedOperations(scrapes: Scrape[]): number {
  let total = 0;
  for (const scrape of scrapes) {
    for (const s of scrape) if (s.name === "wagering_processing_duration_seconds_count") total += s.value;
  }
  return total;
}

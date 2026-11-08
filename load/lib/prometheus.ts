/**
 * Leitura do formato de texto do Prometheus (o que o `prom-client` serve no
 * `/metrics` interno, D22.1) e as contas da carga (D26.4). Código puro: roda
 * no Bun (orquestrador e testes) e no k6 (amostragem durante a carga).
 */

export interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** Uma instância = as amostras de um `/metrics`. */
export type Scrape = Sample[];

const LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)(?:\s+\d+)?$/;
const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"\s*,?\s*/y;

function unescapeLabel(raw: string): string {
  return raw.replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c));
}

function parseLabels(raw: string, line: string): Record<string, string> {
  const labels: Record<string, string> = {};
  LABEL.lastIndex = 0;
  while (LABEL.lastIndex < raw.length) {
    const start = LABEL.lastIndex;
    const match = LABEL.exec(raw);
    if (match === null || match.index !== start) throw new Error(`labels inválidos em: ${line}`);
    labels[match[1] as string] = unescapeLabel(match[2] as string);
  }
  return labels;
}

function parseValue(raw: string, line: string): number {
  if (raw === "+Inf") return Number.POSITIVE_INFINITY;
  if (raw === "-Inf") return Number.NEGATIVE_INFINITY;
  if (raw === "NaN") return Number.NaN;
  const value = Number(raw);
  if (raw === "" || Number.isNaN(value)) throw new Error(`valor inválido em: ${line}`);
  return value;
}

export function parsePrometheus(text: string): Scrape {
  const samples: Scrape = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = LINE.exec(line);
    if (match === null) throw new Error(`linha fora do formato do Prometheus: ${line}`);
    samples.push({
      name: match[1] as string,
      labels: match[2] === undefined ? {} : parseLabels(match[2], line),
      value: parseValue(match[3] as string, line),
    });
  }
  return samples;
}

function matches(labels: Record<string, string>, filter: Record<string, string>): boolean {
  return Object.entries(filter).every(([k, v]) => labels[k] === v);
}

function seriesKey(labels: Record<string, string>): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(",");
}

function assertSameInstances(before: Scrape[], after: Scrape[]): void {
  if (before.length !== after.length) {
    throw new Error(`instâncias diferentes antes (${before.length}) e depois (${after.length})`);
  }
}

/**
 * Aumento de uma série entre duas leituras da mesma instância. Menor depois =
 * o processo reiniciou e o contador voltou a zero: conta o valor de depois
 * (como o `increase()` do Prometheus).
 */
function increase(before: number | undefined, after: number): { value: number; reset: boolean } {
  if (before === undefined) return { value: after, reset: false };
  if (after < before) return { value: after, reset: true };
  return { value: after - before, reset: false };
}

export interface CounterDelta {
  values: Record<string, number>;
  /** Séries que voltaram a zero (processo reiniciado no meio do passo). */
  resets: number;
}

/** Aumento do contador `name` no passo, somado entre as instâncias, por `groupBy`. */
export function counterDelta(
  before: Scrape[],
  after: Scrape[],
  name: string,
  groupBy: string,
  filter: Record<string, string> = {},
): CounterDelta {
  assertSameInstances(before, after);
  const values: Record<string, number> = {};
  let resets = 0;
  after.forEach((afterScrape, i) => {
    const previous = new Map<string, number>();
    for (const s of before[i] ?? []) {
      if (s.name === name && matches(s.labels, filter)) previous.set(seriesKey(s.labels), s.value);
    }
    for (const s of afterScrape) {
      if (s.name !== name || !matches(s.labels, filter)) continue;
      const delta = increase(previous.get(seriesKey(s.labels)), s.value);
      if (delta.reset) resets++;
      const group = s.labels[groupBy] ?? "";
      values[group] = (values[group] ?? 0) + delta.value;
    }
  });
  return { values, resets };
}

export interface Bucket {
  le: number;
  count: number;
}

/** Diferença dos buckets cumulativos do histograma `name`, somada entre as instâncias. */
export function histogramDelta(
  before: Scrape[],
  after: Scrape[],
  name: string,
  filter: Record<string, string> = {},
): Bucket[] {
  const delta = counterDelta(before, after, `${name}_bucket`, "le", filter);
  return Object.entries(delta.values)
    .map(([le, count]) => ({ le: parseValue(le, `le="${le}"`), count }))
    .sort((a, b) => a.le - b.le);
}

/** Maior valor do gauge `name` entre as instâncias; `undefined` se nenhuma o tem. */
export function gaugeMax(scrapes: Scrape[], name: string, filter: Record<string, string> = {}): number | undefined {
  let max: number | undefined;
  for (const scrape of scrapes) {
    for (const s of scrape) {
      if (s.name === name && matches(s.labels, filter) && (max === undefined || s.value > max)) max = s.value;
    }
  }
  return max;
}

/** Percentil acima do maior limite finito dos buckets: só se sabe que passou dele. */
export interface AboveBucket {
  above: number;
}

export type Quantile = number | AboveBucket | undefined;

/**
 * Percentil estimado pelos buckets cumulativos, com interpolação linear
 * dentro do bucket, como o `histogram_quantile` do Prometheus. É uma
 * estimativa: o erro é do tamanho do bucket (dito no relatório).
 */
export function histogramQuantile(buckets: Bucket[], q: number): Quantile {
  const total = buckets.at(-1)?.count ?? 0;
  if (total === 0) return undefined;
  const rank = q * total;
  let lowerLe = 0;
  let lowerCount = 0;
  for (const bucket of buckets) {
    if (bucket.count >= rank) {
      if (bucket.le === Number.POSITIVE_INFINITY) return { above: lowerLe };
      if (bucket.count === lowerCount) return bucket.le;
      return lowerLe + (bucket.le - lowerLe) * ((rank - lowerCount) / (bucket.count - lowerCount));
    }
    lowerLe = bucket.le;
    lowerCount = bucket.count;
  }
  return { above: lowerLe };
}

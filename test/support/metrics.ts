import type { Registry } from "prom-client";
import { METRIC_LABEL_VALUES, metricsRegistry } from "../../src/shared/metrics/metrics";

type Labels = Record<string, string>;

interface MetricValue {
  value: number;
  labels: Record<string, string | number>;
  metricName?: string;
}

/** Os valores de uma métrica do registry do processo (o `get()` roda o `collect` dos gauges). */
export async function metricValues(name: string): Promise<MetricValue[]> {
  const metric = metricsRegistry.getSingleMetric(name);
  if (!metric) throw new Error(`métrica ${name} não registrada`);
  return (await metric.get()).values as MetricValue[];
}

function matches(value: MetricValue, labels: Labels): boolean {
  return Object.entries(labels).every(([key, expected]) => String(value.labels[key]) === expected);
}

/**
 * Soma dos valores de um counter ou gauge cujos labels batem com `labels`.
 * Num histograma, use `histogram()`.
 */
export async function metricValue(name: string, labels: Labels = {}): Promise<number> {
  let total = 0;
  for (const value of await metricValues(name)) {
    if (value.metricName !== undefined && value.metricName !== name) continue;
    if (matches(value, labels)) total += value.value;
  }
  return total;
}

/** `count` e `sum` de um histograma, somados nos labels que batem. */
export async function histogram(name: string, labels: Labels = {}): Promise<{ count: number; sum: number }> {
  let count = 0;
  let sum = 0;
  for (const value of await metricValues(name)) {
    if (!matches(value, labels)) continue;
    if (value.metricName === `${name}_count`) count += value.value;
    if (value.metricName === `${name}_sum`) sum += value.value;
  }
  return { count, sum };
}

/** A lista de valores de cada label, por métrica (D22.11). */
type ClosedSets = Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;

/** O `le` dos histogramas é do prom-client, não nosso. */
const PROM_INTERNAL_LABELS = new Set(["le"]);

/**
 * D22.11: métricas sem lista e labels declarados que a lista **da métrica**
 * não tem. Uma linha por violação; vazio = tudo dentro do conjunto.
 */
export function labelNameViolations(
  registry: Registry = metricsRegistry,
  closed: ClosedSets = METRIC_LABEL_VALUES,
): string[] {
  const violations: string[] = [];
  for (const metric of registry.getMetricsAsArray()) {
    const allowed = closed[metric.name];
    if (!allowed) {
      violations.push(`${metric.name}: sem lista de labels`);
      continue;
    }
    const declared = [...((metric as unknown as { labelNames?: readonly string[] }).labelNames ?? [])].sort();
    const expected = Object.keys(allowed).sort();
    if (declared.join(",") !== expected.join(",")) {
      violations.push(`${metric.name}: declara {${declared.join(",")}}, a lista tem {${expected.join(",")}}`);
    }
  }
  return violations;
}

/**
 * D22.11: cada valor de label observado no registry, conferido contra a
 * lista **da própria métrica** (nunca uma lista compartilhada por nome de
 * label). Roda o `collect` dos gauges.
 */
export async function closedSetViolations(
  registry: Registry = metricsRegistry,
  closed: ClosedSets = METRIC_LABEL_VALUES,
): Promise<string[]> {
  const violations: string[] = [];
  for (const metric of await registry.getMetricsAsJSON()) {
    const allowed = closed[metric.name];
    if (!allowed) {
      violations.push(`${metric.name}: sem lista de labels`);
      continue;
    }
    for (const value of metric.values as MetricValue[]) {
      for (const [label, labelValue] of Object.entries(value.labels)) {
        if (PROM_INTERNAL_LABELS.has(label)) continue;
        if (!allowed[label]?.includes(String(labelValue))) {
          violations.push(`${metric.name}{${label}="${String(labelValue)}"}`);
        }
      }
    }
  }
  return [...new Set(violations)];
}

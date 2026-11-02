import { metricsRegistry } from "../../src/shared/metrics/metrics";

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

/** Todos os valores de label observados no registry, por nome de label (D22.11). */
export async function observedLabelValues(): Promise<Map<string, Set<string>>> {
  const observed = new Map<string, Set<string>>();
  for (const metric of await metricsRegistry.getMetricsAsJSON()) {
    for (const value of metric.values as MetricValue[]) {
      for (const [label, labelValue] of Object.entries(value.labels)) {
        const set = observed.get(label) ?? new Set<string>();
        set.add(String(labelValue));
        observed.set(label, set);
      }
    }
  }
  return observed;
}

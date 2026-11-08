/**
 * Leitura do `--out json` do k6 (uma linha JSON por amostra, com as tags),
 * para contar o que o resumo do k6 não separa: no C, as respostas originais
 * (`idempotentReplay: false`) **por key** (D26.6). Código puro: roda no Bun.
 */

interface K6Line {
  type?: unknown;
  metric?: unknown;
  data?: { value?: unknown; tags?: Record<string, unknown> };
}

/** Soma dos valores das amostras do metric `metric`, agrupadas pela tag `tag`. */
export function countPointsByTag(ndjson: string, metric: string, tag: string): Record<string, number> {
  const counts: Record<string, number> = {};
  ndjson.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (line === "") return;
    let parsed: K6Line;
    try {
      parsed = JSON.parse(line) as K6Line;
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`saída JSON do k6, linha ${index + 1}: ${error.message}`);
      throw error;
    }
    if (parsed.type !== "Point" || parsed.metric !== metric) return;
    const value = parsed.data?.value;
    const group = parsed.data?.tags?.[tag];
    if (typeof value !== "number" || typeof group !== "string") {
      throw new Error(`saída JSON do k6, linha ${index + 1}: amostra de ${metric} sem valor ou sem a tag ${tag}`);
    }
    counts[group] = (counts[group] ?? 0) + value;
  });
  return counts;
}

/** As contagens nas posições 0..keys-1 (0 para a key sem amostra); key fora disso é erro. */
export function perKey(counts: Record<string, number>, keys: number): number[] {
  const result = Array.from({ length: keys }, () => 0);
  for (const [key, n] of Object.entries(counts)) {
    const index = /^\d+$/.test(key) ? Number(key) : -1;
    if (index < 0 || index >= keys) throw new Error(`key ${key} fora de 0..${keys - 1}`);
    result[index] = n;
  }
  return result;
}

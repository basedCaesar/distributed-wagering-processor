import { describe, expect, it } from "bun:test";
import {
  counterDelta,
  gaugeMax,
  histogramDelta,
  histogramQuantile,
  parsePrometheus,
} from "../../../load/lib/prometheus";

/**
 * D26.4: as métricas da carga vêm do `/metrics` interno de cada processo
 * (D22.1), lido antes e depois de cada passo. A diferença é somada entre as
 * instâncias; um processo reiniciado no meio (contador menor depois) conta
 * só o valor de depois, como o `increase()` do Prometheus.
 */

const API_1_BEFORE = `# HELP wallet_lock_conflicts_total conflitos
# TYPE wallet_lock_conflicts_total counter
wallet_lock_conflicts_total{reason="lock_timeout"} 2
wallet_lock_conflicts_total{reason="deadlock"} 0
# HELP wallet_lock_wait_seconds espera
# TYPE wallet_lock_wait_seconds histogram
wallet_lock_wait_seconds_bucket{le="0.01",outcome="acquired"} 10
wallet_lock_wait_seconds_bucket{le="0.1",outcome="acquired"} 18
wallet_lock_wait_seconds_bucket{le="+Inf",outcome="acquired"} 20
wallet_lock_wait_seconds_sum{outcome="acquired"} 0.9
wallet_lock_wait_seconds_count{outcome="acquired"} 20
`;

const API_1_AFTER = `wallet_lock_conflicts_total{reason="lock_timeout"} 7
wallet_lock_conflicts_total{reason="deadlock"} 0
wallet_lock_wait_seconds_bucket{le="0.01",outcome="acquired"} 60
wallet_lock_wait_seconds_bucket{le="0.1",outcome="acquired"} 98
wallet_lock_wait_seconds_bucket{le="+Inf",outcome="acquired"} 120
wallet_lock_wait_seconds_sum{outcome="acquired"} 5.9
wallet_lock_wait_seconds_count{outcome="acquired"} 120
`;

const API_2_BEFORE = `wallet_lock_conflicts_total{reason="lock_timeout"} 1
wallet_lock_wait_seconds_bucket{le="0.01",outcome="acquired"} 0
wallet_lock_wait_seconds_bucket{le="0.1",outcome="acquired"} 0
wallet_lock_wait_seconds_bucket{le="+Inf",outcome="acquired"} 0
`;

const API_2_AFTER = `wallet_lock_conflicts_total{reason="lock_timeout"} 4
wallet_lock_wait_seconds_bucket{le="0.01",outcome="acquired"} 0
wallet_lock_wait_seconds_bucket{le="0.1",outcome="acquired"} 50
wallet_lock_wait_seconds_bucket{le="+Inf",outcome="acquired"} 100
`;

describe("D26.4: leitura do /metrics", () => {
  it("D26.4: lê nome, labels e valor; ignora HELP, TYPE e linhas vazias", () => {
    const samples = parsePrometheus(API_1_BEFORE);
    expect(samples).toContainEqual({ name: "wallet_lock_conflicts_total", labels: { reason: "lock_timeout" }, value: 2 });
    expect(samples).toContainEqual({
      name: "wallet_lock_wait_seconds_bucket",
      labels: { le: "+Inf", outcome: "acquired" },
      value: 20,
    });
    expect(samples.some((s) => s.name.startsWith("#"))).toBe(false);
    // 2 contadores, 3 buckets, _sum e _count.
    expect(samples).toHaveLength(7);
  });

  it("D26.4: métrica sem labels, valor em notação científica e label com aspas escapadas", () => {
    const samples = parsePrometheus('outbox_lag_seconds 1.5e-3\nx_total{a="say \\"hi\\"",b="c\\\\d"} 4\n');
    expect(samples).toEqual([
      { name: "outbox_lag_seconds", labels: {}, value: 0.0015 },
      { name: "x_total", labels: { a: 'say "hi"', b: "c\\d" }, value: 4 },
    ]);
  });

  it("D26.4: linha que não é do formato do Prometheus é erro, não é ignorada", () => {
    expect(() => parsePrometheus("isto não é métrica\n")).toThrow();
    expect(() => parsePrometheus("x_total{a=\"b\"} abc\n")).toThrow();
  });
});

describe("D26.4: diferença somada entre instâncias", () => {
  const before = [parsePrometheus(API_1_BEFORE), parsePrometheus(API_2_BEFORE)];
  const after = [parsePrometheus(API_1_AFTER), parsePrometheus(API_2_AFTER)];

  it("D26.4 D22.5: conflitos de lock por reason, somados entre as instâncias", () => {
    const delta = counterDelta(before, after, "wallet_lock_conflicts_total", "reason");
    expect(delta.values).toEqual({ lock_timeout: 8, deadlock: 0 });
    expect(delta.resets).toBe(0);
  });

  it("D26.4: série que só existe depois conta inteira", () => {
    const delta = counterDelta(
      [parsePrometheus("")],
      [parsePrometheus('wagering_retries_total{component="submission"} 3\n')],
      "wagering_retries_total",
      "component",
    );
    expect(delta.values).toEqual({ submission: 3 });
  });

  it("D26.4: contador menor depois (processo reiniciado) conta o valor de depois e marca o reset", () => {
    const delta = counterDelta(
      [parsePrometheus('wagering_retries_total{component="consumer"} 10\n')],
      [parsePrometheus('wagering_retries_total{component="consumer"} 4\n')],
      "wagering_retries_total",
      "component",
    );
    expect(delta.values).toEqual({ consumer: 4 });
    expect(delta.resets).toBe(1);
  });

  it("D26.4: o número de instâncias antes e depois precisa ser o mesmo", () => {
    expect(() => counterDelta(before, after.slice(0, 1), "wallet_lock_conflicts_total", "reason")).toThrow();
  });

  it("D26.4 D22.5: histograma: diferença dos buckets cumulativos, somada, filtrada por label", () => {
    const delta = histogramDelta(before, after, "wallet_lock_wait_seconds", { outcome: "acquired" });
    expect(delta).toEqual([
      { le: 0.01, count: 50 },
      { le: 0.1, count: 130 },
      { le: Number.POSITIVE_INFINITY, count: 200 },
    ]);
  });

  it("D26.4 D22.6: gauge: o maior valor entre as instâncias", () => {
    const publishers = [parsePrometheus("outbox_lag_seconds 0.4\n"), parsePrometheus("outbox_lag_seconds 1.2\n")];
    expect(gaugeMax(publishers, "outbox_lag_seconds")).toBe(1.2);
    expect(gaugeMax([parsePrometheus("")], "outbox_lag_seconds")).toBeUndefined();
  });
});

describe("D26.4: percentil estimado pelos buckets", () => {
  const buckets = [
    { le: 0.01, count: 50 },
    { le: 0.1, count: 130 },
    { le: Number.POSITIVE_INFINITY, count: 200 },
  ];

  it("D26.4: interpolação linear dentro do bucket, como o histogram_quantile do Prometheus", () => {
    // p25: 50 observações de 200 → fim do 1º bucket.
    expect(histogramQuantile(buckets, 0.25)).toBeCloseTo(0.01, 10);
    // p50: 100ª observação, 50 no bucket 0.01–0.1 de 80 → 0.01 + 0.09 × 50/80.
    expect(histogramQuantile(buckets, 0.5)).toBeCloseTo(0.01 + 0.09 * (50 / 80), 10);
  });

  it("D26.4: percentil no bucket +Inf devolve o maior limite finito, marcado como acima dele", () => {
    expect(histogramQuantile(buckets, 0.99)).toEqual({ above: 0.1 });
  });

  it("D26.4: histograma sem observações não tem percentil", () => {
    expect(histogramQuantile([{ le: 0.1, count: 0 }, { le: Number.POSITIVE_INFINITY, count: 0 }], 0.5)).toBeUndefined();
  });
});
